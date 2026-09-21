# Architecture

English | [中文](ARCHITECTURE.zh.md)

The plugin is a single Cordis service: one class, one overridden method, and per-session state that deliberately does not hang off the instance.

## The seam being wrapped

`ctx.compaction` is a single-slot service. Implementations own trigger policy, retention and summarization, and a successful run replaces a span of the surface with one summary node.

| Piece | Where it comes from | What this plugin does with it |
| --- | --- | --- |
| `compactIfNeeded(agent, trigger, signal)` | the base engine, called from `agent/pre-step` and `agent/request-error` | gates it, then delegates |
| `compactNow(agent, signal, commandId)` | the base engine, called by the `/compact` command | delegates, then re-arms |
| `session/event` | the harness | counts tool turns |

## The override

- The gate reads the session's tracker, which compares the current tool-turn count against the one recorded at the last committed compaction.
- A refusal throws before the base engine is called, so a futile summarization is never spent.
- A refusal also latches. Without the latch the gate would reopen as soon as the gap grew, which would slow the loop rather than stop it.
- A manual compaction is never refused and clears the latch, because a person asking for one compaction is new information.

## Where state lives

Per-session state sits in module-level WeakMaps keyed by session, and the resolved policy is a public own field.

- A realm served this plugin's `ctx.compaction` object without this class's private brands, so a private-field read threw inside the compaction path.
- The host catches errors thrown from that path and continues the turn, so the failure was silent: it disabled automatic compaction rather than reporting anything.
- Module-level maps keyed by session remove the dependence on instance identity entirely, which is the same shape the base package uses for its own balance cache.

## What is deliberately not here

- No summarization, retention or surface surgery: those are the base engine's, and duplicating them would mean two implementations to keep correct.
- No network access and no credential access: the plugin measures what the harness already measured.
- No client half: every surface it adds is host-side, so it ships no browser code.
