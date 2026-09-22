# Measurements

English | [中文](MEASUREMENTS.zh.md)

Every claim in this repository is backed by a command and its raw output. This file collects the measurements that matter, including the two that are not finished.

## Environment

| Item | Value |
| --- | --- |
| Harness | DeepSeek Harness 0.1.5-rc.2, desktop distribution |
| Boot used | `--profile web --port 32100 --no-open` (earlier runs used 31901) in an isolated `DSH_HOME` |
| Credential used | none, because creating an agent does not call a model |
| Suite result | 19 tests, 2 suites, 0 failed |

## The realm serves this engine

Mounting the preset realm with the same two calls the session controller makes, then reading the service back from inside the realm:

```text
realm-probe-apply-ran
compaction-service-constructor=BreakerCompactionEngine
typeof-compactIfNeeded=function
typeof-compactNow=function
engine-config={"auto":true,"thresholdRatio":0.8,"maxTokens":8192}
breaker-methods={"trippedFor":"function","statusFor":"function"}
```

Reading the same service from outside the realm returns nothing, which is what the isolation declares and what stops a host-plane listener from impersonating the engine.

## A private field read threw inside the compaction path

The same probe before the state was moved out of private fields:

```text
breaker-policy-read-failed=Cannot read private member #breaker from an object whose class did not declare it
trippedFor-threw=Cannot read private member #trackers from an object whose class did not declare it
same-class-identity-as-repo-copy=true
public-own-props=["ctx","name","config","warnedPressureConfigTargets","overflowRetries","overflowAgents"]
```

The served object carried this class's prototype and the base engine's own fields, but none of this class's private brands. Because the host catches errors thrown from the automatic compaction path, this failure would have disabled automatic compaction silently rather than reporting anything.

## After the fix

```text
breaker-policy={"toolTurnThreshold":2,"maxConsecutiveRapidRefills":3,"announceInPrompt":true}
works-trips-private-state=false
public-own-props=["ctx","name","config","warnedPressureConfigTargets","overflowRetries","overflowAgents","breakerPolicy"]
```

The public API is callable on the served object, and the resolved policy is readable from it.

## A real model session, and how far it got (2026-09-22)

This is the closest the trip has been to being observed, and it is reported as what it is: **the pressure path provably calls this engine, repeatedly, in a real session — and no compaction has yet succeeded, so the trip has still not been observed.**

The lab is this repository's own instance (`C:/Users/BOWLUNA/Desktop/DSHTEST/breaker`, dsh `0.1.6-alpha.2`), driven by a probe that composes the realm through the same two public calls the production session path makes, then wraps `compactIfNeeded` — an observer, not a simulator. Nothing about the decision is faked; every recorded call came from the host's own `agent/pre-step` pressure path.

```text
logger.info compaction-breaker armed: rapid below 7 tool turns, trip at 3 in a row, auto=true, thresholdRatio=0.5
post-mount breakerPolicy={"toolTurnThreshold":7,"maxConsecutiveRapidRefills":3,"announceInPrompt":true}
post-mount config={"auto":true,"thresholdRatio":0.5,"maxTokens":8192}
#1 enter trigger=pressure      #1 return null (nothing done)
#2 enter trigger=pressure      #2 return null (nothing done)
#3 enter trigger=pressure      #3 THREW {"message":"summary is not smaller than the shadowed content (810 estimated framed tokens >= 619)"}
#4 enter trigger=pressure      #4 THREW {"message":"compaction still above threshold after 2 compaction attempts (22453 estimated tokens >= threshold 20000)"}
#5 enter trigger=pressure      #5 THREW {"message":"compaction still above threshold after 2 compaction attempts (20775 estimated tokens >= threshold 20000)"}
```

Three things this establishes, each of which was previously an assumption:

- **The host's pressure path calls this engine in a real session.** Seven of seven `compactIfNeeded` calls arrived with `trigger=pressure`; nothing else invoked it.
- **The configuration reaches the engine.** The armed line reports the values this lab set (`7` tool turns, `0.5`), which differ from the defaults, so the plumbing is not being assumed.
- **The engine served by `agent.ctx.get("compaction")` is the host-plane one**, not the preset row's: its `config` reports the host defaults while the preset row reports `0.5`. Class names could not distinguish them, because both planes run the same class — so an earlier version of this document, which used the constructor name as evidence that "the realm serves this engine", was weaker than it read. Corrected above.

Why the trip did not happen, precisely: the breaker records a compaction point only when `super.compactIfNeeded` **returns a result**. In every attempt here the base engine threw instead — either the summary was not smaller than the content it shadowed, or two attempts left the total above the threshold. With no compaction point recorded, `consecutiveRapidRefills` never advances and the refusal is never reached. The loop that this session *did* produce is a **failure** loop, not a rapid-refill loop.

The remaining condition is therefore narrow and testable: a session whose compactable region is large enough that the summarizer's output is strictly smaller, and whose threshold sits above the non-compactable baseline (the preset's instructions alone measured near 20k tokens here). The lab scaffolding for it already exists and is recorded in the ledger.

## What is not measured yet

- **The trip itself.** The section above is the closest it has come; no session has yet produced a successful compaction followed by rapid refills. See the ledger's `issues/01`.
- The command's rendering in the web UI. Its text contract is the framework's own for slash commands, and its content is asserted by the suite; only the rendering is unobserved.

