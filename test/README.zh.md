# 测试

[English](README.md) | 简体中文

分两层，因为它们失败的原因不同。

| 套件 | 层次 | 需要 harness |
| --- | --- | --- |
| `test/tracker.test.js` | 策略核心：间隔、rapid、边界、锁定、重置 | 否 |
| `test/engine.test.js` | 接线：模块能加载、配置被接受、两个触发点都被门控 | 是 |

## 怎么跑

```bash
node test/run.mjs
```

`test/run.mjs` 是唯一的入口。CI、文档数字守卫与贡献者都走它，于是「哪些套件存在」只有一个地方决定，输出的形状也只有一种要解析。否则，加进 `test/` 却没被它收进来的套件，会在所有地方被静默跳过。

## 接线那套为什么会跳过

`test/engine.test.js` 会导入本插件，而本插件导入 `@deepseek-ai/dsh-compaction-basic`。那些是 harness 提供的 peer 依赖，所以一个干净的检出解析不到它们。跑 `node tools/link-harness-peers.mjs` 可以从本机的 harness 安装里借用。

解析不到时，这套会跳过而不是失败，而且用例总数不变，因此文档里写的总数在两种情况下都成立。
