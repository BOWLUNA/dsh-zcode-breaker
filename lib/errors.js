/**
 * The breaker's error type and its user-facing wording.
 *
 * One message builder feeds three surfaces — the thrown error, the injected
 * prompt section, and the `/compaction-breaker` command — so the advice a
 * person reads is the same wherever they meet it.
 *
 * @module dsh-compaction-breaker/errors
 */

/** Stable machine-readable reason, matching the original ZCode taxonomy. */
export const RAPID_REFILL_REASON = "compact_rapid_refill_breaker";

/** Actionable advice. The whole point of the breaker is this paragraph. */
export function rapidRefillAdvice(detail) {
  const { consecutiveRapidRefills, maxConsecutiveRapidRefills, toolTurnThreshold, toolTurnsSinceCompact } = detail;
  const since = toolTurnsSinceCompact === null ? "an unknown number of" : String(toolTurnsSinceCompact);
  return [
    `Automatic compaction stopped: the context refilled within fewer than ${toolTurnThreshold} tool turns after compaction, ${consecutiveRapidRefills} time(s) in a row (limit ${maxConsecutiveRapidRefills}).`,
    `The last compaction was ${since} tool turn(s) ago.`,
    "Something is putting more into the window than a summary can take out — usually one very large file read or tool output.",
    "What to do:",
    "  - Read that file or run that command in smaller chunks instead of all at once.",
    "  - Drop the oversized content with a fresh session if it is no longer needed.",
    "  - Run /compact to compact once by hand, or /compaction-breaker reset to re-arm automatic compaction.",
    "This is a per-session stop, not a global disable: your session still works, only automatic compaction is off.",
  ].join("\n");
}

/** One-line summary for session logs and prompt injection. */
export function rapidRefillSummary(detail) {
  const { consecutiveRapidRefills, toolTurnThreshold, toolTurnsSinceCompact } = detail;
  return (
    `compaction rapid-refill breaker tripped: ${consecutiveRapidRefills} consecutive refills ` +
    `under ${toolTurnThreshold} tool turns (last gap ${toolTurnsSinceCompact ?? "n/a"})`
  );
}

/**
 * Raised from `compactIfNeeded` to refuse one automatic compaction.
 *
 * The host's automatic paths catch errors from this method and continue the
 * turn, so this deliberately does not try to be a fatal error: its job is to
 * stop the summarization call, not the session.
 */
export class CompactionRapidRefillError extends Error {
  /** Stable reason for logs and programmatic consumers. */
  reason = RAPID_REFILL_REASON;

  constructor(detail, options) {
    super(rapidRefillAdvice(detail), options);
    this.name = "CompactionRapidRefillError";
    this.detail = detail;
  }
}
