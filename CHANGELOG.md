# Changelog

English | [中文](CHANGELOG.zh.md)

All notable changes to this project are documented here. The format follows Keep a Changelog, and this project adheres to Semantic Versioning.

## [0.1.0] - 2026-09-21

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
