# 参与贡献

[English](CONTRIBUTING.md) | 简体中文

## 开 PR 之前

- 按顺序跑守卫，因为它们互相衔接：先 `node test/run.mjs`，再 `node tools/verify-translation-pairing.mjs --write`，最后 `node tools/verify-doc-numbers.mjs`。
- 任一语言文件改动后都要重录配对哈希。重录只是声明两边已对齐，它不做检查。
- 保持一对文件结构完全一致。配对守卫会逐项比对标题级别、围栏块、表格行、引用与列表项。

## 改动行为

- 策略改动请在 `test/tracker.test.js` 加用例，接线改动请在 `test/engine.test.js` 加用例。没有用例的策略改动，就是一个没人核对的声明。
- 新增配置键时，请在 `static Config` 里声明它、在两份 README 里写上它，并且预期 `verify-doc-numbers.mjs` 在你做完之前会红。

## 范围

- 本引擎只包一个方法。任何需要改动触发策略、保留比例或摘要实现的事情，都该回到上游 `@deepseek-ai/dsh-compaction-basic`，而不是这里。
