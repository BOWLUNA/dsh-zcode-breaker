/**
 * `dsh-compaction-breaker` — stop the futile "compact, refill, compact again"
 * loop that DSH's automatic compaction has no bound for.
 *
 * The base engine compacts on `agent/pre-step` whenever measured pressure
 * exceeds `thresholdRatio`. That path has **no attempt bound**, and every
 * attempt is a full summarization call — so one oversized file read or tool
 * output can make the agent compact once per step, indefinitely.
 *
 * This engine is `@deepseek-ai/dsh-compaction-basic` with one method wrapped:
 * `compactIfNeeded` refuses an automatic attempt once the context has refilled
 * within fewer than `toolTurnThreshold` tool turns, `maxConsecutiveRapidRefills`
 * times in a row. It throws a `CompactionRapidRefillError` carrying actionable
 * advice, and (once tripped) injects one prompt section so the model relays the
 * situation to the person instead of retrying in silence.
 *
 * Everything else — trigger policy, retention, surface mutation, tool-pairing
 * safety, summarization — is the base engine's and stays untouched.
 *
 * Mount it as the only `ctx.compaction` provider of an agent's compaction
 * realm; see README for the preset row. The seam is single-slot
 * (`ctx.provide` throws on a second provider in the same isolate scope), so
 * this replaces `compaction-basic` rather than wrapping it.
 *
 * ## Why there are no `#private` members in this file
 *
 * Measured on a real Web-profile instance (2026-09-21): the object a realm hands
 * out as `ctx.compaction` carries the base engine's own fields and this class's
 * prototype, but **none of this class's private brands** — reading one throws
 * `Cannot read private member #trackers from an object whose class did not declare it`,
 * which would make `compactIfNeeded` throw on every step (silently disabling
 * automatic compaction, because the base's `agent/pre-step` handler swallows
 * and logs such failures).
 *
 * `Service`'s constructor calls `ctx.reflect.provide()` *before* it returns, so
 * the registered instance is not guaranteed to be the object whose private
 * initializers ran. Two rules follow, and both are applied throughout:
 *
 * - **Per-session state lives in module-level WeakMaps keyed by session**, so it
 *   is reachable no matter which object serves the service. `dsh-compaction`
 *   uses the same pattern for its own `balanceCacheBySession`.
 * - **No `#` methods**; internal helpers are `_`-prefixed, matching the base
 *   engine's own `_registerAutomaticCompaction`.
 *
 * @module dsh-compaction-breaker
 */
import z from "@deepseek-ai/schemastery";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import { RapidRefillTracker } from "./lib/tracker.js";
import { CompactionRapidRefillError, rapidRefillAdvice, rapidRefillSummary } from "./lib/errors.js";

/**
 * Keys the base engine's `resolveConfig` accepts. It validates its own key set
 * and **throws on an unknown key**, so this engine's own keys must never reach
 * `super()` — they are filtered out and resolved separately.
 */
const BASE_CONFIG_KEYS = Object.freeze([
  "thresholdRatio",
  "retainRatio",
  "retainTokens",
  "summarizationProvider",
  "summarizationModel",
  "maxTokens",
  "compactionRetries",
  "maxOverflowRetries",
  "modelPolicies",
  "auto",
]);

/** Mirrors the base engine's per-route override shape. */
const modelPolicySchema = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  thresholdRatio: z.number(),
  retainRatio: z.number(),
  retainTokens: z.number().step(1).min(0),
  summarizationProvider: z.string(),
  summarizationModel: z.string(),
  maxTokens: z.number().step(1).min(1),
  compactionRetries: z.number().step(1).min(0),
  maxOverflowRetries: z.number().step(1).min(0),
});

/** Placement of the tripped notice: after the policy sections, before tool docs. */
const ANNOUNCEMENT_ORDER = 700;
const ANNOUNCEMENT_SECTION = "compaction-breaker:tripped";

const DEFAULT_TOOL_TURN_THRESHOLD = 2;
const DEFAULT_MAX_CONSECUTIVE_RAPID_REFILLS = 3;

/** Per-session breaker state. Keyed by session, so it does not depend on which
 * object serves the service. Weak, so ended sessions are dropped. */
const TRACKERS = new WeakMap();
/** Sessions whose trip has already been logged and announced. */
const ANNOUNCED = new WeakSet();
/** Disposer for each session's injected "automatic compaction is off" section. */
const SECTION_DISPOSERS = new WeakMap();
/** Resolved policy per engine instance, for consumers holding the instance. */
const POLICIES = new WeakMap();

/** Keep only the keys the base engine's validator allows. */
function baseConfigOf(config) {
  const base = {};
  for (const key of BASE_CONFIG_KEYS) {
    if (config[key] !== undefined) base[key] = config[key];
  }
  return base;
}

/** Narrow an unknown thrown value to a message. */
function message(error) {
  return error instanceof Error ? error.message : String(error);
}

class BreakerCompactionEngine extends BasicCompactionEngine {
  /**
   * The base engine's hard dependencies, unchanged. `commands` and
   * `systemPrompt` are resolved optionally via `ctx.get` instead of being
   * injected, so a realm that lacks them still mounts a working engine.
   */
  static inject = ["llm", "tokenMeter", "sessions"];

  /**
   * The base engine's key set re-declared verbatim (its schemas carry no
   * defaults — `resolveConfig` supplies those) plus this engine's own keys.
   * Re-declaration is mandatory: an inherited `Config` would reject the
   * breaker's keys before `apply` ever runs.
   */
  static Config = z.object({
    thresholdRatio: z.number(),
    retainRatio: z.number(),
    retainTokens: z.number().step(1).min(0),
    summarizationProvider: z.string(),
    summarizationModel: z.string(),
    maxTokens: z.number().step(1).min(1),
    compactionRetries: z.number().step(1).min(0),
    maxOverflowRetries: z.number().step(1).min(0),
    modelPolicies: z.array(modelPolicySchema),
    auto: z.boolean(),
    toolTurnThreshold: z.number().step(1).min(1).default(DEFAULT_TOOL_TURN_THRESHOLD),
    maxConsecutiveRapidRefills: z.number().step(1).min(1).default(DEFAULT_MAX_CONSECUTIVE_RAPID_REFILLS),
    announceInPrompt: z.boolean().default(true),
  });

  /**
   * The resolved rapid-refill policy. A plain public field, deliberately not a
   * `#private` one — see the module note.
   */
  breakerPolicy = Object.freeze({
    toolTurnThreshold: DEFAULT_TOOL_TURN_THRESHOLD,
    maxConsecutiveRapidRefills: DEFAULT_MAX_CONSECUTIVE_RAPID_REFILLS,
    announceInPrompt: true,
  });

  constructor(ctx, config = {}) {
    super(ctx, baseConfigOf(config));
    this.breakerPolicy = Object.freeze({
      toolTurnThreshold: config.toolTurnThreshold ?? DEFAULT_TOOL_TURN_THRESHOLD,
      maxConsecutiveRapidRefills: config.maxConsecutiveRapidRefills ?? DEFAULT_MAX_CONSECUTIVE_RAPID_REFILLS,
      announceInPrompt: config.announceInPrompt ?? true,
    });
    POLICIES.set(this, this.breakerPolicy);
    // One line at mount time: which engine is serving `ctx.compaction` and with
    // what policy is the first thing anyone debugging compaction wants to know.
    // Optional-chained: a missing logger must not abort the mount.
    ctx.logger?.info(
      `compaction-breaker armed: rapid below ${this.breakerPolicy.toolTurnThreshold} tool turns, ` +
        `trip at ${this.breakerPolicy.maxConsecutiveRapidRefills} in a row, ` +
        `auto=${this.config?.auto}, thresholdRatio=${this.config?.thresholdRatio}`,
    );
    this._observeToolTurns();
    this._registerCommand();
  }

  /** The resolved rapid-refill policy, or `undefined` when unreadable. */
  get policy() {
    return this.breakerPolicy ?? POLICIES.get(this);
  }

  /**
   * Count tool turns from the durable session log rather than from step
   * numbers: a "tool turn" is one assistant message that issued at least one
   * tool call, which is the same unit the compaction seam itself uses when it
   * reasons about surface balance.
   */
  _observeToolTurns() {
    this.ctx.on("session/event", (session, event) => {
      if (event?.type !== "assistant/message") return;
      const content = event.data?.message?.content;
      if (!Array.isArray(content)) return;
      if (!content.some((block) => block?.type === "tool-call")) return;
      this._trackerFor(session).noteToolTurn();
    });
  }

  _trackerFor(session) {
    let tracker = TRACKERS.get(session);
    if (tracker === undefined) {
      tracker = new RapidRefillTracker(this.breakerPolicy);
      TRACKERS.set(session, tracker);
    }
    return tracker;
  }

  /** Assemble the policy detail carried by the error, the log, and the prompt. */
  _detail(snapshot) {
    return {
      consecutiveRapidRefills: snapshot.consecutiveRapidRefills,
      maxConsecutiveRapidRefills: snapshot.maxConsecutiveRapidRefills,
      toolTurnThreshold: snapshot.toolTurnThreshold,
      toolTurnsSinceCompact: snapshot.toolTurnsSinceCompact,
      compactions: snapshot.compactions,
    };
  }

  /**
   * Whether the breaker is currently holding this session's automatic
   * compaction off. Exposed for the command surface and for other plugins that
   * want to render the state.
   *
   * @param session - the session to inspect.
   * @returns true while a trip is latched (i.e. until reset or a manual compaction).
   */
  trippedFor(session) {
    return TRACKERS.get(session)?.tripped ?? false;
  }

  /**
   * Read-only breaker state for one session, or `undefined` when this session
   * has never been gated.
   *
   * @param session - the session to inspect.
   */
  statusFor(session) {
    return TRACKERS.get(session)?.snapshot();
  }

  /**
   * Log the trip once, and tell the model — the host catches errors thrown
   * from `compactIfNeeded` and continues the turn, so a thrown error alone
   * would leave the person with no explanation for why compaction stopped.
   */
  _announceTrip(session, detail) {
    if (ANNOUNCED.has(session)) return;
    ANNOUNCED.add(session);
    this.ctx.logger?.warn(rapidRefillSummary(detail));
    if (!this.breakerPolicy.announceInPrompt) return;
    const systemPrompt = this.ctx.get("systemPrompt");
    if (systemPrompt === undefined) return;
    try {
      const dispose = systemPrompt.section({
        name: ANNOUNCEMENT_SECTION,
        order: ANNOUNCEMENT_ORDER,
        text: [
          "## Automatic compaction is switched off for this session",
          "",
          "The compaction breaker tripped. Relay this to the user briefly, then continue:",
          rapidRefillAdvice(detail),
        ].join("\n"),
      });
      SECTION_DISPOSERS.set(session, dispose);
    } catch (error) {
      // A missing or already-occupied section must never turn an advisory into
      // a second failure; the log line above still carries the diagnosis.
      this.ctx.logger?.warn(`compaction breaker could not register its prompt section: ${message(error)}`);
    }
  }

  /** Drop the announcement and re-arm. */
  _clearTrip(session) {
    ANNOUNCED.delete(session);
    const dispose = SECTION_DISPOSERS.get(session);
    if (dispose !== undefined) {
      SECTION_DISPOSERS.delete(session);
      try {
        dispose();
      } catch (error) {
        this.ctx.logger?.warn(`compaction breaker could not dispose its prompt section: ${message(error)}`);
      }
    }
  }

  /**
   * Gate one automatic compaction, then delegate.
   *
   * Both automatic triggers — step-boundary `pressure` and
   * `context-overflow` recovery — pass through here, because the base engine
   * dispatches this method dynamically at event time.
   *
   * @param agent - the agent whose latest durable request is measured.
   * @param trigger - `pressure` or `context-overflow`.
   * @param signal - live cancellation signal, forwarded untouched.
   * @returns the base engine's compaction result, or `null` when none ran.
   */
  async compactIfNeeded(agent, trigger, signal) {
    const tracker = this._trackerFor(agent.session);
    const gate = tracker.gate();
    if (gate.blocked) {
      const detail = this._detail(tracker.snapshot());
      this._announceTrip(agent.session, detail);
      throw new CompactionRapidRefillError(detail);
    }
    const result = await super.compactIfNeeded(agent, trigger, signal);
    if (result !== null) {
      const snapshot = tracker.commitCompaction(gate.projectedConsecutiveRapidRefills);
      if (snapshot.tripped) this._announceTrip(agent.session, this._detail(snapshot));
    }
    return result;
  }

  /**
   * Manual `/compact` is never refused: a person asking for one compaction is
   * new information, and it is also the sanctioned way out of a trip. A
   * successful manual compaction therefore re-arms the automatic path.
   */
  async compactNow(agent, signal, sourceCommandId) {
    const tracker = this._trackerFor(agent.session);
    const result = await super.compactNow(agent, signal, sourceCommandId);
    if (result !== null) {
      this._clearTrip(agent.session);
      tracker.reset();
    }
    return result;
  }

  /** `/compaction-breaker` [status|reset] */
  _registerCommand() {
    const commands = this.ctx.get("commands");
    if (commands === undefined) return;
    const engine = this;
    this.ctx.effect(
      function* () {
        yield commands.register({
          name: "compaction-breaker",
          description: "Show or reset the automatic-compaction rapid-refill breaker",
          handler: (invocation) => engine._command(invocation),
        });
      },
      "compaction-breaker command",
    );
  }

  _command(invocation) {
    const session = invocation.agent?.session;
    const tracker = session === undefined ? undefined : TRACKERS.get(session);
    const verb = invocation.rawInput.trim().toLowerCase();
    if (verb === "reset") {
      if (tracker === undefined) {
        return { kind: "success", text: "Nothing to reset: no compaction has been tracked in this session." };
      }
      if (session !== undefined) this._clearTrip(session);
      const snapshot = tracker.reset();
      return { kind: "success", text: `Breaker re-armed. Tool turns so far: ${snapshot.toolTurns}.` };
    }
    if (verb !== "" && verb !== "status") {
      return { kind: "error", text: "Usage: /compaction-breaker [status|reset]" };
    }
    if (tracker === undefined) {
      return {
        kind: "success",
        text: "State: armed.\nNo compaction has been gated in this session yet; automatic compaction is running normally.",
      };
    }
    const s = tracker.snapshot();
    return {
      kind: "success",
      text: [
        s.tripped ? "State: TRIPPED — automatic compaction is off for this session." : "State: armed.",
        `Tool turns observed: ${s.toolTurns}`,
        `Compactions: ${s.compactions}`,
        `Rapid refills in a row: ${s.consecutiveRapidRefills} / ${s.maxConsecutiveRapidRefills}`,
        `Tool turns since last compaction: ${s.toolTurnsSinceCompact ?? "n/a"} (rapid below ${s.toolTurnThreshold})`,
        s.blockedAttempts > 0 ? `Automatic attempts refused: ${s.blockedAttempts}` : undefined,
        s.tripped ? "Run /compact to compact once by hand, or /compaction-breaker reset to re-arm." : undefined,
      ]
        .filter((line) => line !== undefined)
        .join("\n"),
    };
  }
}

export { BreakerCompactionEngine };
export { BreakerCompactionEngine as default };
