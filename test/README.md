# Tests

English | [中文](README.zh.md)

Two layers, because they fail for different reasons.

| Suite | Layer | Needs the harness |
| --- | --- | --- |
| `test/tracker.test.js` | the policy core: gaps, rapids, the boundary, latching, reset | no |
| `test/engine.test.js` | the wiring: the module loads, the config is accepted, both triggers are gated | yes |

## Running them

```bash
node test/run.mjs
```

`test/run.mjs` is the single entry point. CI, the documented-numbers guard and contributors all go through it, so there is one place that decides which suites exist and one summary shape to parse. A suite added to `test/` but not picked up there would otherwise be skipped everywhere.

## Why the wiring suite may skip

`test/engine.test.js` imports the plugin, which imports `@deepseek-ai/dsh-compaction-basic`. Those are peer dependencies supplied by the harness, so a bare checkout cannot resolve them. Run `node tools/link-harness-peers.mjs` to borrow them from a harness installation.

Where they cannot be resolved the suite skips rather than fails, and the case count stays the same, so the documented totals remain true either way.
