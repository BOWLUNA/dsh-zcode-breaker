# 变更日志

[English](CHANGELOG.md) | 简体中文

本项目的所有重要变更都记录在这里。格式遵循 Keep a Changelog，版本号遵循语义化版本。

## [1.0.1] - 2026-09-21

**运行时代码没有任何改动**：`lib/`、`index.js` 与 bundle patch 与 1.0.0 逐字节相同。这一版修的是「本该抓住 1.0.0 附近那类缺陷」的机制本身。

### 新增

- `tools/boot-check.mjs` —— 把插件装进一次性的 `DSH_HOME`，要求它出现在合成树里，然后**真的启动一个 harness 并要求它对外服务**。本仓库其余所有检查都只是读文件，**没有任何一项会去 apply 一个 bundle patch**，所以「行里写的包解析不到」这类缺陷能从它们眼皮底下全部过去。

### 修复

- CI 现在在每一条矩阵腿上都真启动一次。这道检查已用**变异副本**证明会红：把行 `name` 改回改名前的旧名，它会红；而同一时刻 `--dump-config` 仍然 exit 0、stderr 为空、而且**照样列出那一行** —— 这就是只读文件的检查替代不了它的原因。
- release 工作流现在会建 GitHub Release。此前 `permissions.contents` 是 `read` 且没有这一步，所以推了 tag 之后仓库首页的 Releases 面板停在上一版；v1.0.0 的 Release 是用 API 手工建的。该步骤带 `if: always()`，并钉死 `set -euo pipefail`，所以 CHANGELOG 抽取失败会中止，而不是拿上一版的说明去建 Release。

## 1.0.0

首个公开发布版。下面那条 0.1.x 属于开发期记录，从未发布过，所以这是第一个能从 registry 装到的版本。

### 包含

- 自动压缩的 rapid-refill 熔断器：它包住 `compactIfNeeded`，拒绝一次徒劳的压缩尝试。
- 拒绝发生在摘要调用之前，而且会**锁定**，所以这个循环是停下来了，而不只是变慢。
- 熔断期间注入一个 prompt 段：宿主会吞掉从自动路径抛出的错误，否则用户只会看到压缩被静默关掉。
- `/compaction-breaker` 命令，带 `status` 与 `reset`；另有可复用的策略核心导出在 `dsh-zcode-breaker/tracker`。
- 一个覆盖宿主平面会话的 bundle patch，以及覆盖 agent 会话的那一行 preset。

### 兼容性

- 在 dsh 0.1.5-rc.2 上开发并验证过。本包声明的区间写在 `engines.dsh` 里，这里刻意不复述。
- 用到的宿主 API：`ctx.compaction`、`ctx.tokenMeter`、`ctx.sessions`、`ctx.systemPrompt`、`ctx.commands`、`ctx.logger`，以及 `session/event` 事件。

## [0.1.0] - 2026-09-21

开发期记录，从未发布。

### 新增

- rapid-refill 熔断：当上下文在距上次压缩不足 `toolTurnThreshold` 个工具轮次内又满、且连续达到 `maxConsecutiveRapidRefills` 次时，`compactIfNeeded` 会拒绝这次自动压缩，并抛出携带可操作建议的 `CompactionRapidRefillError`。
- 锁定式熔断：一旦拒绝，该 session 的自动路径就保持关闭直到被重新武装，而不是等间隔一超过阈值就自己放开。
- 熔断期间注入一个 prompt 段，让模型把情况转述给人；否则宿主会把错误吞掉，压缩就那么静悄悄地停了。
- `/compaction-breaker` 命令，带 `status` 与 `reset`。
- 可复用的策略核心 `dsh-zcode-breaker/tracker`，让别的压缩后端也能接入同一套熔断。
- 模块级的按会话状态——因为域交出来的那个服务对象，不保证是私有初始化器跑过的那个。

### 已验证

- 在隔离 `DSH_HOME` 里的真实 web profile 启动，加上通过 `agentPresets.mount()` 组合出的真实 agent preset 域：域里的 `ctx.compaction` 报出的是本插件的引擎类，且它的公开 API 可调用。

### 尚未完成

- 模型驱动的那段验收还没跑：还没有任何会话通过真实压缩压力把熔断驱动到跳闸。
