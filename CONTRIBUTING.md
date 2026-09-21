# Contributing

English | [中文](CONTRIBUTING.zh.md)

## Before you open a pull request

- Run the guards in order, because each one feeds the next: `node test/run.mjs`, then `node tools/verify-translation-pairing.mjs --write`, then `node tools/verify-doc-numbers.mjs`.
- Re-record the pairing hashes whenever either side of a translated document changes. Re-recording declares the pair aligned; it does not check it.
- Keep both sides of a pair structurally identical. The pairing guard compares heading levels, fenced blocks, table rows, quotes and list items item by item.

## Changing behaviour

- Add a case to `test/tracker.test.js` for a policy change, and to `test/engine.test.js` for a wiring change. A policy change without a case is a claim nobody checks.
- If you add a configuration key, declare it in `static Config`, document it in both READMEs, and expect `verify-doc-numbers.mjs` to fail until you do.

## Scope

- The engine wraps one method. Anything that needs to change trigger policy, retention or summarization belongs upstream in `@deepseek-ai/dsh-compaction-basic`, not here.
