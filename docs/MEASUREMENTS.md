# Measurements

English | [中文](MEASUREMENTS.zh.md)

Every claim in this repository is backed by a command and its raw output. This file collects the measurements that matter, including the two that are not finished.

## Environment

| Item | Value |
| --- | --- |
| Harness | DeepSeek Harness 0.1.5-rc.2, desktop distribution |
| Boot used | `--profile web --port 31901 --no-open` in an isolated `DSH_HOME` |
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

## What is not measured yet

- The model-driven acceptance: no session has yet produced real compaction pressure, so the breaker's trip has never been observed end to end. It needs a valid model credential, which this machine does not have.
- The command's rendering in the web UI. Its text contract is the framework's own for slash commands, and its content is asserted by the suite; only the rendering is unobserved.
