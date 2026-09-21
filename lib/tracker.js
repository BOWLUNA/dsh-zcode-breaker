/**
 * Rapid-refill tracking: the pure decision core of the breaker.
 *
 * Kept free of any DSH/Cordis import so it is unit-testable in isolation and
 * so the policy can be reused by other compaction backends.
 *
 * The condition this detects: automatic compaction runs, and the context is
 * back over the compaction threshold within very few tool turns — repeatedly.
 * DSH's `agent/pre-step` pressure path has no attempt bound, and every attempt
 * costs a full summarization call, so an unbounded refill loop burns one model
 * call per step until the session is abandoned.
 *
 * Terminology matches the original ZCode implementation:
 * `consecutiveRapidRefills` / `maxConsecutiveRapidRefills` /
 * `toolTurnsSinceCompact` / `toolTurnThreshold`.
 *
 * @module dsh-compaction-breaker/tracker
 */

/** A "tool turn" is one assistant message that issued at least one tool call. */
const DEFAULT_STATE = Object.freeze({
  toolTurns: 0,
  lastCompactionToolTurn: null,
  consecutiveRapidRefills: 0,
  tripped: false,
  compactions: 0,
  blockedAttempts: 0,
});

export class RapidRefillTracker {
  /** @type {number} */
  #toolTurnThreshold;
  /** @type {number} */
  #maxConsecutiveRapidRefills;
  /** @type {typeof DEFAULT_STATE} */
  #state;

  /**
   * @param {object} options
   * @param {number} options.toolTurnThreshold - A refill closer than this many
   *   tool turns after the previous compaction counts as "rapid".
   * @param {number} options.maxConsecutiveRapidRefills - How many rapid refills
   *   in a row trip the breaker.
   */
  constructor({ toolTurnThreshold, maxConsecutiveRapidRefills }) {
    if (!Number.isFinite(toolTurnThreshold) || toolTurnThreshold < 1) {
      throw new TypeError("toolTurnThreshold must be a finite number >= 1");
    }
    if (!Number.isFinite(maxConsecutiveRapidRefills) || maxConsecutiveRapidRefills < 1) {
      throw new TypeError("maxConsecutiveRapidRefills must be a finite number >= 1");
    }
    this.#toolTurnThreshold = toolTurnThreshold;
    this.#maxConsecutiveRapidRefills = maxConsecutiveRapidRefills;
    this.#state = { ...DEFAULT_STATE };
  }

  /** Record one more tool turn (assistant message carrying >= 1 tool call). */
  noteToolTurn() {
    this.#state.toolTurns += 1;
    return this.#state.toolTurns;
  }

  /** Tool turns counted so far in this session. */
  get toolTurns() {
    return this.#state.toolTurns;
  }

  /** Whether the breaker has tripped for this session. */
  get tripped() {
    return this.#state.tripped;
  }

  /** Tool turns elapsed since the last committed compaction, or null when none ran. */
  get toolTurnsSinceCompact() {
    if (this.#state.lastCompactionToolTurn === null) return null;
    return this.#state.toolTurns - this.#state.lastCompactionToolTurn;
  }

  /** Consecutive rapid refills committed so far. */
  get consecutiveRapidRefills() {
    return this.#state.consecutiveRapidRefills;
  }

  /** How many compaction attempts this tracker has refused. */
  get blockedAttempts() {
    return this.#state.blockedAttempts;
  }

  /** Read-only snapshot for logs, commands, and tests. */
  snapshot() {
    return {
      toolTurns: this.#state.toolTurns,
      toolTurnsSinceCompact: this.toolTurnsSinceCompact,
      consecutiveRapidRefills: this.#state.consecutiveRapidRefills,
      maxConsecutiveRapidRefills: this.#maxConsecutiveRapidRefills,
      toolTurnThreshold: this.#toolTurnThreshold,
      compactions: this.#state.compactions,
      blockedAttempts: this.#state.blockedAttempts,
      tripped: this.#state.tripped,
    };
  }

  /**
   * Decide whether one automatic compaction attempt may proceed.
   *
   * Pure with respect to the consecutive counter: it projects what that count
   * *would* become if this attempt commits, so a refused attempt does not
   * itself advance it. Call {@link commitCompaction} when the attempt actually
   * produced a summary.
   *
   * A refusal **latches** the trip. Without that, a refusal would not commit,
   * `tripped` would never become true, and the breaker would release itself
   * once the gap grew past the threshold — blocking twice, allowing once, and
   * still burning a summarization call every few steps. The latch is what makes
   * this a stop rather than a slowdown; only {@link reset} or a manual
   * compaction clears it.
   *
   * @returns {{blocked: boolean, rapid: boolean, toolTurnsSinceCompact: number|null,
   *   projectedConsecutiveRapidRefills: number, reason: string}}
   */
  gate() {
    if (this.#state.tripped) {
      this.#state.blockedAttempts += 1;
      return {
        blocked: true,
        rapid: true,
        toolTurnsSinceCompact: this.toolTurnsSinceCompact,
        projectedConsecutiveRapidRefills: this.#state.consecutiveRapidRefills,
        reason: "breaker_already_tripped",
      };
    }
    // No compaction has committed yet: nothing to compare against.
    if (this.#state.lastCompactionToolTurn === null) {
      return {
        blocked: false,
        rapid: false,
        toolTurnsSinceCompact: null,
        projectedConsecutiveRapidRefills: 0,
        reason: "first_compaction",
      };
    }
    const since = this.#state.toolTurns - this.#state.lastCompactionToolTurn;
    const rapid = since < this.#toolTurnThreshold;
    const projected = rapid ? this.#state.consecutiveRapidRefills + 1 : 0;
    const blocked = projected >= this.#maxConsecutiveRapidRefills;
    if (blocked) {
      this.#state.blockedAttempts += 1;
      this.#state.tripped = true;
    }
    return {
      blocked,
      rapid,
      toolTurnsSinceCompact: since,
      projectedConsecutiveRapidRefills: projected,
      reason: blocked ? "rapid_refill_limit_reached" : rapid ? "rapid_refill" : "healthy_gap",
    };
  }

  /**
   * Commit one compaction that actually produced a summary.
   *
   * Applies the projection {@link gate} reported: a rapid refill advances the
   * consecutive count (tripping at the configured maximum), a healthy gap
   * resets it. This is the only place the count moves.
   *
   * @param {number} [projectedConsecutiveRapidRefills] - the projection from the
   *   matching `gate()` call; recomputed from current state when omitted.
   * @returns {ReturnType<RapidRefillTracker["snapshot"]>}
   */
  commitCompaction(projectedConsecutiveRapidRefills) {
    const since = this.toolTurnsSinceCompact;
    const rapid = since === null ? false : since < this.#toolTurnThreshold;
    const consecutive = projectedConsecutiveRapidRefills ?? (rapid ? this.#state.consecutiveRapidRefills + 1 : 0);
    this.#state.consecutiveRapidRefills = consecutive;
    this.#state.lastCompactionToolTurn = this.#state.toolTurns;
    this.#state.compactions += 1;
    if (consecutive >= this.#maxConsecutiveRapidRefills) this.#state.tripped = true;
    return this.snapshot();
  }

  /**
   * Clear the trip and the rapid-refill history.
   *
   * Two callers: an explicit human reset, and a manual `/compact` — a person
   * deliberately compacting is new information, and it would be wrong to keep
   * refusing them because of what the automatic path did earlier.
   *
   * The tool-turn counter deliberately does NOT reset: it is the session's
   * monotonic clock, and zeroing it would make every subsequent gap look
   * "healthy" regardless of how much work actually ran.
   */
  reset() {
    this.#state.consecutiveRapidRefills = 0;
    this.#state.lastCompactionToolTurn = this.#state.toolTurns;
    this.#state.tripped = false;
    this.#state.blockedAttempts = 0;
    return this.snapshot();
  }
}

export { DEFAULT_STATE };
