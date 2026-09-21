# 变更日志

[English](CHANGELOG.md) | 简体中文

本项目的所有重要变更都记录在这里。格式遵循 Keep a Changelog，版本号遵循语义化版本。

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
