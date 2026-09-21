# dsh-zcode-breaker

English | [中文](README.zh.md)

A rapid-refill circuit breaker for DeepSeek Harness automatic compaction: it stops the futile compact-refill-compact loop and tells the user which oversized read or tool output caused it. Derived from the ZCode implementation of the same idea.

## The problem, concretely

Automatic compaction has two trigger paths in `@deepseek-ai/dsh-compaction-basic`:

| Trigger | Entry point | Attempt bound |
| --- | --- | --- |
| Step-boundary pressure | `agent/pre-step` calls `compactIfNeeded(agent, "pressure")` | none |
| Context-overflow recovery | `agent/request-error` calls `compactIfNeeded(agent, "context-overflow")` | `maxOverflowRetries` |

The pressure path is unbounded: once measured pressure exceeds `thresholdRatio`, the next step compacts again, and every compaction is a full summarization model call. One oversized file read or tool output therefore produces a loop that burns a model call per step until the session is abandoned, and the transcript shows only this repeating line:

```text
compaction (step pressure): shadowed N surface nodes (seqs A-B, ~T tokens)
```

## What it does

It extends `BasicCompactionEngine` and wraps exactly one method, `compactIfNeeded`:

- State is per session, so sessions cannot pollute each other.
- A tool turn is read from the durable session log: one assistant message carrying at least one tool call. That is the unit the compaction seam itself uses when it reasons about surface balance, rather than a guessed step count.
- A compaction requested fewer than `toolTurnThreshold` tool turns after the previous one counts as a rapid refill.
- At `maxConsecutiveRapidRefills` in a row the attempt is refused before it runs, so the summarization call is never spent.
- A refusal latches and throws a `CompactionRapidRefillError` carrying actionable advice.
- It also injects one prompt section while tripped, because the host catches errors from `compactIfNeeded` and continues the turn: a thrown error alone would leave the person with no explanation.
- The command `/compaction-breaker` reports the state and can re-arm it.

Everything else stays the base engine's: trigger policy, retention, surface mutation, tool-pairing safety and summarization.

## Mounting: a preset row, not a profile patch

This is the part most likely to be got wrong. `compaction-basic` exists twice in a stock harness: once as a host-plane row in `@deepseek-ai/dsh-base`, and once inside the agent preset's compaction group, which is declared `isolate: { compaction: true, toolResultPruner: true }`. An agent session resolves `ctx.compaction` inside that isolated realm, so disabling the host row changes nothing for the agent, and the realm is composed from preset YAML that never appears in `dsh --profile web --dump-config`.

The seam is also single-slot: a second provider in the same isolate scope makes `ctx.provide()` throw, and `ctx.reflect.set()` accepts writes only from the owning fiber. This plugin therefore replaces that row; it cannot wrap it from a sibling row.

### Install

```bash
dsh plugin --profile web add dsh-zcode-breaker
```

The install prints a warning that the package declares no `dsh.bundle`. That is expected: this plugin is referenced by a preset row rather than mounted as a profile layer.

Then replace the row in your preset's `agent.cordis.yml`:

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-breaker
      name: 'dsh-zcode-breaker'
      config:
        toolTurnThreshold: 2
        maxConsecutiveRapidRefills: 3
    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'
```

Copy the preset into your user preset directory rather than editing the shipped one, or a harness upgrade will overwrite the edit.

## Configuration

Every base-engine key survives, re-declared on the subclass so it is neither rejected by the base engine's strict validator nor lost:

| Key | Default | Meaning |
| --- | --- | --- |
| `thresholdRatio` | `0.8` | pressure ratio that triggers compaction |
| `retainRatio` | `0.16` | retained tail ratio after compaction |
| `retainTokens` | none | absolute token retention instead of the ratio |
| `summarizationProvider` | empty | route used for summaries |
| `summarizationModel` | empty | model used for summaries |
| `maxTokens` | `8192` | summary output cap |
| `compactionRetries` | `1` | retries after a failed summary |
| `maxOverflowRetries` | `1` | overflow-recovery retries |
| `modelPolicies` | none | per provider and model overrides of the keys above |
| `auto` | `true` | automatic compaction master switch |

Added by this plugin:

| Key | Default | Meaning |
| --- | --- | --- |
| `toolTurnThreshold` | `2` | a gap under this many tool turns is rapid; exactly the threshold is not |
| `maxConsecutiveRapidRefills` | `3` | refuse on the Nth consecutive rapid refill |
| `announceInPrompt` | `true` | inject the advisory prompt section once tripped |

That is 13 config keys in total, and this file declares compatibility with dsh `>=0.1.5-rc.2 <0.2.0-0`.

## Surfaces

| Surface | What it shows |
| --- | --- |
| Log | one warn line naming the consecutive count, the threshold and the last gap |
| `/compaction-breaker` | a state report; `/compaction-breaker reset` re-arms |
| Prompt section | injected while tripped, instructing the model to relay the situation |

## Semantics — three deliberate decisions

1. A refusal latches. A refused attempt never commits, so without latching the breaker would release itself once the gap passed the threshold, blocking twice and allowing once. The latch is what makes this a stop rather than a slowdown.
2. Two ways out exist: the reset subcommand, or a successful manual `/compact`. A person deliberately compacting is new information and should not be refused because of what the automatic path did earlier.
3. Reset does not zero the tool-turn clock. It is the session's monotonic clock, and zeroing it would make every later gap look healthy. Only the rapid counter, the last compaction mark, the latch and the refused-attempt count are cleared.

A trip is not a global disable: the session keeps working, only automatic compaction is off for it.

## Compatibility and known limits

- It is mutually exclusive with other compaction engines. Several backends occupy the same `ctx.compaction` slot, and none of them can be mounted alongside this engine. That is a limitation of the seam rather than a choice made here.
- The host-plane row is untouched, so sessions that do not compose a preset are unaffected.
- Base defaults are inherited, since the base engine's own schema carries no defaults and its resolver supplies them. A future base-engine key therefore needs re-declaring here to remain configurable.
- State lives in module-level WeakMaps rather than private class fields. That is deliberate: the object a realm hands out as `ctx.compaction` is not reliably the one whose private initializers ran, and a private-field read would throw inside the compaction path where the host swallows it.
- The model-driven end-to-end acceptance has not been run. Everything up to and including the engine serving `ctx.compaction` inside a real realm is verified; see `docs/MEASUREMENTS.md`.

### Composing with another backend

The policy core is exported so another backend can adopt it in roughly twenty lines:

```js
import { RapidRefillTracker } from 'dsh-zcode-breaker/tracker';

const tracker = new RapidRefillTracker({ toolTurnThreshold: 2, maxConsecutiveRapidRefills: 3 });
tracker.noteToolTurn();
const gate = tracker.gate();
if (gate.blocked) throw new Error('rapid refill loop');
const result = await myEngine.compact();
if (result !== null) tracker.commitCompaction(gate.projectedConsecutiveRapidRefills);
```

## Tests

```bash
npm test
```

19 tests in 2 suites, with no services, no model and no session: the policy core in `test/tracker.test.js` and the engine wiring in `test/engine.test.js`. The wiring suite needs the peer packages resolvable and skips rather than fails where they are missing.

## Roadmap

- Run the model-driven acceptance: build a refill loop in a real session and watch the breaker trip.
- Choose the base class at runtime, so the breaker composes with whichever backend a user prefers.
- Offer the policy core upstream to `@deepseek-ai/dsh-compaction-basic`.

## License

MIT
