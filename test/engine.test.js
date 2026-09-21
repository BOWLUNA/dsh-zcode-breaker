/**
 * Wiring tests for the engine itself: does the override observe tool turns,
 * gate the automatic paths, delegate when allowed, and stay out of the manual
 * path?
 *
 * The base engine is stubbed (`compactIfNeeded` / `compactNow` on its prototype)
 * so this runs without a DSH session, a model, or a token meter. It needs the
 * peer packages resolvable, which normally means the plugin is installed in a
 * profile; where they are missing the suite skips rather than fails.
 */
import assert from "node:assert/strict";
import test from "node:test";

let plugin = undefined;
let loadError = undefined;
try {
  plugin = await import("../index.js");
} catch (error) {
  loadError = error;
}

const unavailable = loadError === undefined ? false : `peer packages not resolvable here (${loadError.message})`;
const options = unavailable ? { skip: unavailable } : {};

/** Minimal Cordis-shaped context: event registry, optional services, effects. */
function fakeCtx() {
  const handlers = new Map();
  const sections = [];
  const commands = [];
  const disposers = [];
  return {
    handlers,
    sections,
    commands,
    disposers,
    logger: { warn() {}, info() {}, error() {}, debug() {} },
    reflect: { provide: () => () => {} },
    on(type, handler) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(handler);
      return () => {};
    },
    get(name) {
      if (name === "systemPrompt") {
        return {
          section(section) {
            sections.push(section);
            return () => {};
          },
        };
      }
      if (name === "commands") {
        return {
          register(command) {
            commands.push(command);
            return () => {};
          },
        };
      }
      return undefined;
    },
    effect(callback, label) {
      if (typeof callback !== "function") return undefined;
      const iterator = callback();
      if (iterator === undefined || typeof iterator[Symbol.iterator] !== "function") return iterator;
      for (const disposer of iterator) disposers.push(disposer);
      return undefined;
    },
    emit() {},
  };
}

/** A stand-in session; only identity matters to the breaker. */
function fakeSession(id) {
  return { id };
}

/** An agent carrying a session. */
function fakeAgent(session) {
  return { session };
}

test("the engine mounts, exports a service class, and keeps the base dependencies", options, async () => {
  const { BreakerCompactionEngine } = plugin;
  assert.equal(typeof BreakerCompactionEngine, "function");
  assert.deepEqual(BreakerCompactionEngine.inject, ["llm", "tokenMeter", "sessions"]);
  const ctx = fakeCtx();
  const engine = new BreakerCompactionEngine(ctx, { auto: false, toolTurnThreshold: 2, maxConsecutiveRapidRefills: 3 });
  assert.ok(engine instanceof plugin.BreakerCompactionEngine);
});

test("this engine's own keys never reach the base engine's strict validator", options, async () => {
  const { BreakerCompactionEngine } = plugin;
  const ctx = fakeCtx();
  // The base engine's resolveConfig throws on an unknown key; if the breaker
  // forwarded its own keys, construction would fail right here.
  const engine = new BreakerCompactionEngine(ctx, {
    auto: false,
    toolTurnThreshold: 5,
    maxConsecutiveRapidRefills: 4,
    announceInPrompt: false,
  });
  assert.equal(engine.config.auto, false);
  // The base engine's own defaults must survive the re-declared Config.
  assert.equal(engine.config.maxTokens, 8192);
  assert.equal(engine.config.compactionRetries, 1);
});

test("compactIfNeeded delegates while healthy and refuses once the loop is proven", options, async () => {
  const { BreakerCompactionEngine } = plugin;
  // `__proto__` of a class is its parent *constructor*; the methods to stub live
  // on that parent's prototype.
  const base = Object.getPrototypeOf(BreakerCompactionEngine).prototype;
  const original = base.compactIfNeeded;
  const originalManual = base.compactNow;
  let delegated = 0;
  base.compactIfNeeded = async () => {
    delegated += 1;
    return { shadowedSeqs: [1, 2], shadowedRange: { start: 1, end: 2 }, shadowedTokenCount: 10, summarySeq: 9 };
  };
  base.compactNow = async () => ({ shadowedSeqs: [3], shadowedRange: { start: 3, end: 3 }, shadowedTokenCount: 4, summarySeq: 11 });

  try {
    const ctx = fakeCtx();
    const engine = new BreakerCompactionEngine(ctx, {
      auto: false,
      toolTurnThreshold: 2,
      maxConsecutiveRapidRefills: 2,
    });
    const session = fakeSession("s1");
    const agent = fakeAgent(session);
    const signal = { aborted: false };

    // The engine must have subscribed to session events to see tool turns.
    const eventHandlers = ctx.handlers.get("session/event") ?? [];
    assert.equal(eventHandlers.length, 1, "the engine observes tool turns");
    const emitToolTurn = () =>
      eventHandlers[0](session, { type: "assistant/message", data: { message: { content: [{ type: "tool-call" }] } } });
    const emitPlainTurn = () =>
      eventHandlers[0](session, { type: "assistant/message", data: { message: { content: [{ type: "text" }] } } });

    // A message with no tool call is not a tool turn.
    for (let i = 0; i < 5; i += 1) emitPlainTurn();

    // Baseline compaction after a healthy amount of work.
    for (let i = 0; i < 3; i += 1) emitToolTurn();
    await engine.compactIfNeeded(agent, "pressure", signal);
    assert.equal(delegated, 1, "the first compaction delegates");

    // Rapid refill #1: allowed, and it delegates.
    emitToolTurn();
    await engine.compactIfNeeded(agent, "pressure", signal);
    assert.equal(delegated, 2);

    // Rapid refill #2 hits the limit: refused before the summarization runs.
    emitToolTurn();
    await assert.rejects(
      () => engine.compactIfNeeded(agent, "pressure", signal),
      (error) => {
        assert.equal(error.name, "CompactionRapidRefillError");
        assert.equal(error.reason, "compact_rapid_refill_breaker");
        assert.match(error.message, /Read that file or run that command in smaller chunks/);
        return true;
      },
    );
    assert.equal(delegated, 2, "a refused attempt must not call the base engine");

    // Still refused on later steps, and now visibly announced to the model.
    emitToolTurn();
    await assert.rejects(() => engine.compactIfNeeded(agent, "pressure", signal));
    assert.equal(delegated, 2);
    assert.equal(ctx.sections.length, 1, "the trip registers exactly one prompt section");
    assert.equal(ctx.sections[0].name, "compaction-breaker:tripped");

    // An overflow-triggered attempt is gated too — same override, other trigger.
    await assert.rejects(() => engine.compactIfNeeded(agent, "context-overflow", signal));

    // A manual compaction is never refused, and it re-arms the automatic path.
    const manual = await engine.compactNow(agent, signal, "cmd-1");
    assert.notEqual(manual, null);
    assert.equal(engine.trippedFor(session), false, "manual compaction re-arms");
    emitToolTurn();
    await engine.compactIfNeeded(agent, "pressure", signal);
    assert.equal(delegated, 3, "the automatic path works again after a manual compaction");
  } finally {
    base.compactIfNeeded = original;
    base.compactNow = originalManual;
  }
});

test("a refused attempt leaves other sessions untouched", options, async () => {
  const { BreakerCompactionEngine } = plugin;
  const base = Object.getPrototypeOf(BreakerCompactionEngine).prototype;
  const original = base.compactIfNeeded;
  base.compactIfNeeded = async () => ({ shadowedSeqs: [1], shadowedRange: { start: 1, end: 1 }, shadowedTokenCount: 1, summarySeq: 1 });
  try {
    const ctx = fakeCtx();
    const engine = new BreakerCompactionEngine(ctx, { auto: false, toolTurnThreshold: 2, maxConsecutiveRapidRefills: 1 });
    const [a, b] = [fakeSession("a"), fakeSession("b")];
    const onEvent = ctx.handlers.get("session/event")[0];
    const turn = (session) =>
      onEvent(session, { type: "assistant/message", data: { message: { content: [{ type: "tool-call" }] } } });

    // Session A: baseline then one rapid refill -> refused at the limit of 1.
    turn(a);
    turn(a);
    await engine.compactIfNeeded(fakeAgent(a), "pressure", { aborted: false });
    turn(a);
    await assert.rejects(() => engine.compactIfNeeded(fakeAgent(a), "pressure", { aborted: false }));
    assert.equal(engine.trippedFor(a), true);

    // Session B is a different agent and must not inherit the trip.
    turn(b);
    assert.equal(engine.trippedFor(b), false);
    await engine.compactIfNeeded(fakeAgent(b), "pressure", { aborted: false });
  } finally {
    base.compactIfNeeded = original;
  }
});

test("the /compaction-breaker command reports state and resets on request", options, async () => {
  const { BreakerCompactionEngine } = plugin;
  const ctx = fakeCtx();
  const engine = new BreakerCompactionEngine(ctx, { auto: false, toolTurnThreshold: 2, maxConsecutiveRapidRefills: 2 });
  assert.equal(ctx.commands.length, 1, "the engine registers its command");
  const command = ctx.commands[0];
  assert.equal(command.name, "compaction-breaker");

  const session = fakeSession("cmd");
  const invocation = { agent: { session }, rawInput: "status" };
  const status = command.handler(invocation);
  assert.equal(status.kind, "success");
  assert.match(status.text, /State: armed/);

  const bad = command.handler({ ...invocation, rawInput: "nonsense" });
  assert.equal(bad.kind, "error");
  assert.match(bad.text, /Usage: \/compaction-breaker/);

  const reset = command.handler({ ...invocation, rawInput: "reset" });
  assert.equal(reset.kind, "success");
  assert.match(reset.text, /re-armed|Nothing to reset/);
});
