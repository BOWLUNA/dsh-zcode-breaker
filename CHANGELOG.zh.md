# 变更日志

[English](CHANGELOG.md) | 简体中文

本项目的所有重要变更都记录在这里。格式遵循 Keep a Changelog，版本号遵循语义化版本。

## [0.1.0] - 2026-09-21

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
