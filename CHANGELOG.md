# Changelog

English | [中文](CHANGELOG.zh.md)

All notable changes to this project are documented here. The format follows Keep a Changelog, and this project adheres to Semantic Versioning.

## [1.0.1] - 2026-09-21

No runtime change: `lib/`, `index.js` and the bundle patch are byte-identical to 1.0.0. This release fixes the machinery that was supposed to catch the class of defect that shipped in 1.0.0's neighbourhood.

### Added

- `tools/boot-check.mjs` — installs the plugin into a throwaway `DSH_HOME`, requires the row to appear in the composed tree, and then actually starts a harness and requires it to serve. Every other check in this repository reads files, and none of them *applies* a bundle patch, so a row naming a package that cannot be resolved passed all of them.

### Fixed

- CI now boots the plugin on every matrix leg. The check was proved to fail on a mutated copy whose row name was changed back to the pre-rename name — and on that copy `--dump-config` still exited 0, wrote nothing to stderr, and still listed the row, which is why file-reading checks cannot replace it.
- The release workflow creates the GitHub Release. `permissions.contents` was `read` and there was no such step, so pushing a tag left the Releases panel frozen on the previous version; the v1.0.0 Release had been created by hand through the API. The step is guarded with `if: always()` and pins `set -euo pipefail`, so a failing CHANGELOG extraction aborts instead of cutting a Release with the previous version's notes.

## 1.0.0

First public release. The 0.1.x entry below was development history and was never published, so this is the first version anyone can install from a registry.

### Included

- A rapid-refill circuit breaker for automatic compaction: it wraps `compactIfNeeded` and refuses an attempt that would be futile.
- The refusal happens before the summarization call and it latches, so the loop stops rather than merely slowing down.
- One prompt section injected while tripped, because the host swallows errors thrown from the automatic path and would otherwise leave the user with silently disabled compaction.
- The `/compaction-breaker` command, with `status` and `reset`, plus a reusable policy core exported at `dsh-zcode-breaker/tracker`.
- A bundle patch that covers host-plane sessions, plus the single preset row that covers agent sessions.

### Compatibility

- Developed and verified on dsh 0.1.5-rc.2. The range this package declares lives in `engines.dsh` and is deliberately not restated here.
- Host APIs used: `ctx.compaction`, `ctx.tokenMeter`, `ctx.sessions`, `ctx.systemPrompt`, `ctx.commands`, `ctx.logger`, and the `session/event` event.

## [0.1.0] - 2026-09-21

Development line, never published.

### Added

- The rapid-refill breaker: `compactIfNeeded` refuses an automatic compaction once the context has refilled within fewer than `toolTurnThreshold` tool turns, `maxConsecutiveRapidRefills` times in a row, and throws a `CompactionRapidRefillError` carrying actionable advice.
- A latched trip: a refusal keeps the automatic path off for that session until it is re-armed, instead of releasing itself as soon as the gap grows past the threshold.
- One prompt section injected while tripped, so the model relays the situation to the person; the host otherwise swallows the error and compaction simply stops.
- The `/compaction-breaker` command, with `status` and `reset`.
- The reusable policy core at `dsh-zcode-breaker/tracker`, so another compaction backend can adopt the same breaker.
- Module-level per-session state, chosen because the service object a realm hands out is not reliably the one whose private initializers ran.

### Verified

- A real Web-profile boot in an isolated `DSH_HOME`, plus a real agent preset realm composed through `agentPresets.mount()`: the realm's `ctx.compaction` reports this plugin's engine class and its public API is callable.

### Not yet

- The model-driven acceptance has not been run: no session has yet driven the breaker to trip through real compaction pressure.
