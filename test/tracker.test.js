/**
 * Policy tests for the rapid-refill tracker.
 *
 * These run against the pure decision core with no DSH process, no model, and
 * no session — they are the fast regression net for the one thing that must not
 * be wrong: when the breaker refuses a compaction.
 *
 * Scenario numbers refer to the acceptance table in `DSH插件项目/05-候选池-B档.md`.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { RapidRefillTracker } from "../lib/tracker.js";
import { CompactionRapidRefillError, RAPID_REFILL_REASON, rapidRefillAdvice } from "../lib/errors.js";

/** A tracker with the shipped defaults (rapid below 2 tool turns, trip at 3). */
function tracker(options = {}) {
  return new RapidRefillTracker({ toolTurnThreshold: 2, maxConsecutiveRapidRefills: 3, ...options });
}

/** Compact once after `turns` tool turns, the way the engine's hook does. */
function compactAfter(t, turns) {
  for (let i = 0; i < turns; i += 1) t.noteToolTurn();
  const gate = t.gate();
  assert.equal(gate.blocked, false, "expected the attempt to be allowed");
  return { gate, snapshot: t.commitCompaction(gate.projectedConsecutiveRapidRefills) };
}

test("the first compaction is always allowed (cannot know a gap yet)", () => {
  const t = tracker();
  t.noteToolTurn();
  const gate = t.gate();
  assert.equal(gate.blocked, false);
  assert.equal(gate.reason, "first_compaction");
  assert.equal(gate.toolTurnsSinceCompact, null);
});

test("场景 1: a healthy gap never trips the breaker, however long the run", () => {
  const t = tracker();
  for (let i = 0; i < 40; i += 1) {
    compactAfter(t, 10);
    assert.equal(t.tripped, false);
    assert.equal(t.consecutiveRapidRefills, 0);
  }
  assert.equal(t.snapshot().compactions, 40);
});

test("场景 2: the Mth rapid attempt is refused rather than run — no summarization is burned", () => {
  const t = tracker({ maxConsecutiveRapidRefills: 3 });
  compactAfter(t, 5); // baseline compaction, no gap to compare against yet
  compactAfter(t, 1); // rapid #1 runs
  assert.equal(t.tripped, false);
  assert.equal(t.consecutiveRapidRefills, 1);
  compactAfter(t, 1); // rapid #2 runs
  assert.equal(t.tripped, false);
  assert.equal(t.consecutiveRapidRefills, 2);

  t.noteToolTurn(); // rapid #3 is requested
  const gate = t.gate();
  assert.equal(gate.blocked, true, "the third rapid refill is the one that stops the loop");
  assert.equal(gate.projectedConsecutiveRapidRefills, 3);
  assert.equal(gate.reason, "rapid_refill_limit_reached");
  assert.equal(t.tripped, true, "refusing must latch, or the breaker releases itself later");
  assert.equal(t.snapshot().compactions, 3, "baseline + two rapids ran; the third rapid never did");
});

test("the trip happens before the futile compaction, not after it", () => {
  const t = tracker({ maxConsecutiveRapidRefills: 2 });
  compactAfter(t, 4);
  compactAfter(t, 1); // rapid #1
  t.noteToolTurn(); // rapid #2 is about to be requested
  const gate = t.gate();
  assert.equal(gate.blocked, true);
  assert.equal(gate.reason, "rapid_refill_limit_reached");
  // The refusal must not have consumed a compaction.
  assert.equal(t.snapshot().compactions, 2);
});

test("a refused attempt does not advance the counter", () => {
  const t = tracker({ maxConsecutiveRapidRefills: 2 });
  compactAfter(t, 4);
  compactAfter(t, 1);
  t.noteToolTurn();
  for (let i = 0; i < 5; i += 1) {
    const gate = t.gate();
    assert.equal(gate.blocked, true);
    assert.equal(t.consecutiveRapidRefills, 1, "the counter must not drift on refusals");
  }
  assert.equal(t.blockedAttempts, 5);
});

test("once tripped, every later attempt stays refused", () => {
  const t = tracker({ maxConsecutiveRapidRefills: 2 });
  compactAfter(t, 3);
  compactAfter(t, 1);
  t.noteToolTurn();
  assert.equal(t.gate().blocked, true);
  for (let i = 0; i < 20; i += 1) t.noteToolTurn();
  const gate = t.gate();
  assert.equal(gate.blocked, true);
  assert.equal(gate.reason, "breaker_already_tripped");
});

test("场景 7: a long healthy gap resets the count instead of latching", () => {
  const t = tracker({ maxConsecutiveRapidRefills: 3 });
  compactAfter(t, 5);
  compactAfter(t, 1); // rapid #1
  compactAfter(t, 1); // rapid #2
  compactAfter(t, 9); // healthy gap -> reset
  assert.equal(t.consecutiveRapidRefills, 0);
  assert.equal(t.tripped, false);
  compactAfter(t, 1); // rapid #1 again, from zero
  assert.equal(t.consecutiveRapidRefills, 1);
  assert.equal(t.tripped, false);
});

test("场景 3/6: reset() re-arms immediately, as a manual /compact does", () => {
  const t = tracker({ maxConsecutiveRapidRefills: 2 });
  compactAfter(t, 3);
  compactAfter(t, 1);
  t.noteToolTurn();
  assert.equal(t.gate().blocked, true);
  const snap = t.reset();
  assert.equal(snap.tripped, false);
  assert.equal(snap.consecutiveRapidRefills, 0);
  assert.equal(snap.blockedAttempts, 0);
  assert.equal(t.gate().blocked, false);
});

test("reset() keeps the tool-turn clock monotonic", () => {
  const t = tracker();
  compactAfter(t, 12);
  const before = t.toolTurns;
  t.reset();
  assert.equal(t.toolTurns, before, "zeroing the clock would make every later gap look healthy");
  compactAfter(t, 1);
  assert.equal(t.consecutiveRapidRefills, 1);
});

test("场景 4: state is per tracker, so sessions cannot pollute each other", () => {
  const a = tracker({ maxConsecutiveRapidRefills: 2 });
  const b = tracker({ maxConsecutiveRapidRefills: 2 });
  compactAfter(a, 3);
  compactAfter(a, 1);
  a.noteToolTurn();
  assert.equal(a.gate().blocked, true);
  assert.equal(b.gate().blocked, false, "a fresh session must be unaffected");
  assert.equal(b.tripped, false);
});

test("the threshold boundary is exclusive: exactly N tool turns is a healthy gap", () => {
  const t = tracker({ toolTurnThreshold: 3, maxConsecutiveRapidRefills: 2 });
  compactAfter(t, 0);
  compactAfter(t, 2); // 2 < 3 -> rapid
  assert.equal(t.consecutiveRapidRefills, 1);
  compactAfter(t, 3); // 3 is not < 3 -> healthy
  assert.equal(t.consecutiveRapidRefills, 0);
});

test("场景 5: snapshot exposes every field the command and logs report", () => {
  const t = tracker();
  compactAfter(t, 2);
  assert.deepEqual(t.snapshot(), {
    toolTurns: 2,
    toolTurnsSinceCompact: 0,
    consecutiveRapidRefills: 0,
    maxConsecutiveRapidRefills: 3,
    toolTurnThreshold: 2,
    compactions: 1,
    blockedAttempts: 0,
    tripped: false,
  });
});

test("constructor rejects nonsense thresholds instead of silently disabling the breaker", () => {
  assert.throws(() => new RapidRefillTracker({ toolTurnThreshold: 0, maxConsecutiveRapidRefills: 3 }), TypeError);
  assert.throws(() => new RapidRefillTracker({ toolTurnThreshold: 2, maxConsecutiveRapidRefills: 0 }), TypeError);
  assert.throws(() => new RapidRefillTracker({ toolTurnThreshold: Number.NaN, maxConsecutiveRapidRefills: 3 }), TypeError);
});

test("the error carries the reason machine-readably and actionable advice verbatim", () => {
  const detail = {
    consecutiveRapidRefills: 3,
    maxConsecutiveRapidRefills: 3,
    toolTurnThreshold: 2,
    toolTurnsSinceCompact: 1,
    compactions: 4,
  };
  const error = new CompactionRapidRefillError(detail);
  assert.equal(error.reason, RAPID_REFILL_REASON);
  assert.equal(error.name, "CompactionRapidRefillError");
  assert.match(error.message, /Read that file or run that command in smaller chunks/);
  assert.match(error.message, /\/compaction-breaker reset/);
  assert.match(error.message, /still works/);
  // The advice text is the single source for all three surfaces.
  assert.equal(error.message, rapidRefillAdvice(detail));
});
