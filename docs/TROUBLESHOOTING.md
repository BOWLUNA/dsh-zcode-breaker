# Troubleshooting

English | [中文](TROUBLESHOOTING.zh.md)

## The plugin does not appear to be mounted

- A preset row never shows up in `dsh --profile web --dump-config`, because presets are composed at session start rather than in the profile tree. Its absence there is not evidence of anything.
- The row resolves against the profile that is booting, not against `DSH_HOME`. A plugin installed only into the web profile will not resolve for a headless boot.
- If the row's package cannot be resolved the whole preset is reported as broken and silently not used, so check that the engine is reachable before debugging anything else.

## The breaker never trips

- The breaker only counts automatic compaction. A manual compaction re-arms it, and so does a healthy gap longer than the threshold.
- The trigger is a fast refill, not a large context. A session that compacts once and then stabilises will never trip it, by design.
- If automatic compaction is off for the session, nothing calls the gate at all, so there is nothing to trip.

## Compaction stopped and nobody said why

- A thrown error from the automatic path is logged and swallowed by the host, so the visible signal is the prompt section and the warn line rather than a failure.
- Look for the warn line naming the consecutive count, the threshold and the last gap.
- Run `/compaction-breaker` to see whether the trip is latched, then `/compaction-breaker reset` to re-arm it.

## How to inspect it without a browser

- Mount a probe plugin with `--patch` and have it write to a file; a CLI boot emits no logger stream, so logging is not evidence.
- Compose a preset realm without a session by calling `agents.create` and then `agentPresets.mount`, both of which are the calls the production session controller makes.
- Read the engine back out of the realm to confirm which class serves `ctx.compaction` and what policy it resolved.
