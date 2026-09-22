# dsh-zcode-breaker

[English](README.md) | 简体中文

[![test](https://github.com/BOWLUNA/dsh-zcode-breaker/actions/workflows/test.yml/badge.svg)](https://github.com/BOWLUNA/dsh-zcode-breaker/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
[![dsh 0.1.5-rc.2 | 0.1.6-alpha.2](https://img.shields.io/badge/dsh-0.1.5--rc.2%20%7C%200.1.6--alpha.2-blue)](package.json)
[![node >=22.19](https://img.shields.io/badge/node-%3E%3D22.19-blue)](package.json)

给 DeepSeek Harness 自动压缩用的 rapid-refill 熔断器：拦住「压完立刻又满、于是每一步都再压一次」这个死循环，并告诉用户是哪个过大的读取或工具输出造成的。思路来自 ZCode 的同名实现。

```bash
dsh plugin --profile web add dsh-zcode-breaker
```

> **Node：** 本插件所挂的宿主在 node 20 上**装不出来** —— 在 node 20 上 `npm install @deepseek-ai/dsh`
> 只装入 10 个包、没有 `dsh` 可执行文件，而 node 24 上是 488 个。
> `package.json` 目前仍声明 `>=20`；徽章写的是**实测值**。
> 提高声明下限是一件待拍板的事，不在这里悄悄改掉。

## 从 ZCode 取了什么，又在哪里走得更远

每一行都应该可核对：「取了什么」那一列指向 ZCode 的具体文件与行号，「走得更远」那一列必须是本插件真的做到、而 ZCode 那条路径做不到的事。没有可主张的，就如实写「暂未超过」，不编。

| ZCode 有什么 | 本插件取了什么 | 本插件多了什么（**优于**在哪） | 证据 |
| --- | --- | --- | --- |
| rapid-refill 状态机 —— `consecutiveRapidRefills`、`toolTurnsSinceCompact`、`toolTurnThreshold`（`core/src/compact/turn-loop-state.ts`） | 同样这三件状态 | 工具轮次是从 DSH 的**持久会话日志**里读出来的（一条带至少一次工具调用的 assistant 消息），而不是 ZCode 自己 turn loop 里的计数器。这与压缩接缝判断表面平衡时用的是同一个单位 —— 是**量出来的**，不是猜出来的步数 | `test/tracker.test.js` |
| `RapidRefillDecision.shouldBlock`，reason 为 `compact_rapid_refill_breaker`（`core/src/compact/runtime/methods/compact.ts`） | 同样的拒绝语义，且**在摘要调用之前**拒绝 | 拒绝会**锁定**（latch）：循环是**停下来**，而不只是变慢；摘要调用一次都不花 | `index.js` 的 `compactIfNeeded`；真实会话里观察到 —— 见 `docs/MEASUREMENTS.md` |
| 阈值是模块级常量（`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` 等） | 三个配置键：`toolTurnThreshold`、`maxConsecutiveRapidRefills`、`announceInPrompt` | 阈值是**行配置**而不是编译期常量，所以 profile 行与 preset 行可以不一样 | `logger.info compaction-breaker armed: rapid below 7 tool turns, trip at 3 in a row` |
| 停机提示由 CLI 打印 | 熔断期间注入一个 prompt 段，另有 `/compaction-breaker status\|reset` | DSH 的宿主**会吞掉自动压缩路径抛出的错误**并继续这一轮。只抛错，用户只会看到压缩被静默关掉而没有任何解释 —— 注入提示段才是让「停下」可见的东西 | `index.js` 的 prompt section；`AGENTS.md`「Never break these」#3 |
| `microcompact.ts` —— 整条清空旧工具结果、保留最近 5 条，带工具白名单与空闲 60 分钟触发 | **不取** | **暂未超过。** DSH 自带一个不同的确定性 pruner；本插件刻意不重做 ZCode 那套 | — |
| 熔断挂在 ZCode 自己的 turn loop 上 | 挂在 DSH 的 `agent/pre-step` 步压力路径上，替换 `ctx.compaction` 里的一行 | 不依赖外部 CLI 的轮次概念，并且以「单槽位服务的一行替换」接入 | `cordis.patch.yml`；`docs/MEASUREMENTS.md` 里的 `trigger=pressure` |

## 它解决的具体问题

`@deepseek-ai/dsh-compaction-basic` 里自动压缩有两条触发路径：

| 触发 | 入口 | 次数上限 |
| --- | --- | --- |
| 步边界压力 | `agent/pre-step` 调 `compactIfNeeded(agent, "pressure")` | 无 |
| 溢出恢复 | `agent/request-error` 调 `compactIfNeeded(agent, "context-overflow")` | `maxOverflowRetries` |

压力那条是无上限的：测得的压力一旦超过 `thresholdRatio`，下一步就再压一次，而每次压缩都是一次完整的摘要模型调用。于是一次过大的文件读取或工具输出就能造出这样一个循环——每一步烧掉一次模型调用，直到会话被放弃，而转录里只会反复出现下面这一行：

```text
compaction (step pressure): shadowed N surface nodes (seqs A-B, ~T tokens)
```

## 它做了什么

它继承 `BasicCompactionEngine`，只包住一个方法：`compactIfNeeded`。

- 状态按 session 隔离，多会话互不污染。
- 「工具轮次」取自持久会话日志：一条带至少一个工具调用的助手消息。这与压缩接缝自己判断 surface 配对时用的口径一致，而不是猜的步数。
- 距上次压缩不足 `toolTurnThreshold` 个工具轮次又需要压缩，记一次 rapid refill。
- 连续达到 `maxConsecutiveRapidRefills` 次时，**在这次压缩真正执行之前**就拒绝它，那一发摘要调用永远不会被花掉。
- 拒绝会**锁定状态**，并抛出携带可操作建议的 `CompactionRapidRefillError`。
- 熔断期间还会注入一个 prompt 段。因为宿主会吞掉 `compactIfNeeded` 抛出的错误并继续该轮，只抛错的话用户什么都看不到。
- 命令 `/compaction-breaker` 用来查看状态并重新武装。

其余全部保留父类行为：触发策略、保留比例、surface 改写、工具配对安全与摘要实现。

## 两个平面，以及为什么两个都要管

标准 harness 里 `compaction-basic` 存在**两份**：一份是 `@deepseek-ai/dsh-base` 的宿主平面行，另一份在 agent preset 的 compaction 分组里，该分组声明了 `isolate: { compaction: true, toolResultPruner: true }`。agent 会话的 `ctx.compaction` 解析到那个隔离域里，而不加入任何 preset 的会话解析到宿主那一行。这就是为什么只打 profile 补丁改变不了 agent 的压缩，也是本节后半段那个 preset 行存在的原因。

这个接缝是**单槽位**的：同一 isolate 作用域出现第二个 provider 会让 `ctx.provide()` 抛错，而 `ctx.reflect.set()` 只接受持有该服务的 fiber 的写入。因此每个平面都靠**替换它那一行**来覆盖，而不是遮蔽它。

| 平面 | 服务谁 | 本包怎么覆盖它 |
| --- | --- | --- |
| 宿主 | 不加入任何 agent preset 的会话 | 自动，通过安装器挂上的 bundle patch |
| agent 域 | 每一个普通会话 | 在你的 agent preset 里替换一行，因为任何 profile 补丁都够不到一个域 |

### 安装

```bash
dsh plugin --profile web add dsh-zcode-breaker
```

安装会挂上 `cordis.patch.yml`，它把宿主平面的 `compaction-basic` 行停掉，把这个引擎放到它原来的位置。之所以是替换而不是包覆，是单槽位逼出来的。

接着，为了 agent 会话，替换你的 preset 里 `agent.cordis.yml` 中 `compaction` 分组的那一行：

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

请把 preset 复制到你的用户 preset 目录再改，而不是直接改随包分发的那份，否则 harness 升级会覆盖你的改动。

## 配置

父类的每个键都保留下来，并在子类上重新声明，因此既不会被父类的严格校验器拒掉，也不会丢失：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `thresholdRatio` | `0.8` | 触发压缩的压力比例 |
| `retainRatio` | `0.16` | 压缩后保留的尾部比例 |
| `retainTokens` | 无 | 用绝对 token 数代替上面的比例 |
| `summarizationProvider` | 空 | 摘要用哪条路由 |
| `summarizationModel` | 空 | 摘要用哪个模型 |
| `maxTokens` | `8192` | 摘要输出上限 |
| `compactionRetries` | `1` | 摘要失败后的重试次数 |
| `maxOverflowRetries` | `1` | 溢出恢复的重试次数 |
| `modelPolicies` | 无 | 按 provider 与模型覆写上述各项 |
| `auto` | `true` | 自动压缩总开关 |

本插件新增的键：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `toolTurnThreshold` | `2` | 间隔小于这个工具轮次数就算 rapid；恰好等于不算 |
| `maxConsecutiveRapidRefills` | `3` | 连续第几次 rapid refill 时拒绝 |
| `announceInPrompt` | `true` | 熔断后是否注入那段建议 prompt |

合计 **13 个配置项**，并且本文件声明兼容 dsh `>=0.1.5-rc.2 <0.1.6-0 || >=0.1.6-alpha.1 <0.2.0-0`。

## 用户能看到的面

| 面 | 内容 |
| --- | --- |
| 日志 | 一行 warn，写明连续次数、阈值与上一次间隔 |
| `/compaction-breaker` | 状态报告；`/compaction-breaker reset` 重新武装 |
| prompt 段 | 熔断期间注入，指示模型把情况转述给人 |

## 状态语义——三个刻意的决定

1. 拒绝即锁定。被拒绝的尝试不会 commit，所以若不锁定，间隔一超过阈值就会自动放开，变成「拦两次放一次」。锁定才让它成为**停机**而不是**减速**。
2. 只有两条出路：reset 子命令，或一次成功的**手动** `/compact`。人工主动压缩是新信息，不该被自动路径的历史拦住。
3. 重置**不**清零工具轮次时钟。那是会话的单调时钟，清零会让之后所有间隔都显得健康。被清掉的只有 rapid 计数、上次压缩标记、锁定与拒绝次数。

熔断不是全局禁用：会话照常可用，只是它这一个 session 的自动压缩停了。

## 兼容性与已知边界

- 它与其它压缩引擎**互斥**。若干后端都占同一个 `ctx.compaction` 槽位，它们都无法与本引擎同时挂载。这是接缝本身的限制，不是本插件的选择。
- 宿主平面那一行不受影响，因此不组合 preset 的会话完全不受影响。
- 父类默认值被继承：父类自己的 schema 不带默认值，默认值由它的 resolver 提供。因此父类将来新增的键需要在这里重新声明，才能继续可配。
- 状态放在**模块级 WeakMap**，而不是类的私有字段。这是刻意的：域交给使用方的那个 `ctx.compaction` 对象，不保证是私有初始化器跑过的那个，而私有字段读取会在压缩路径里抛错——偏偏那里宿主会把错误吞掉。
- **模型驱动的那一段端到端验收尚未跑过。** 直到「引擎在真实域里服务 `ctx.compaction`」为止的每一步都已验证，详见 `docs/MEASUREMENTS.md`。

### 与别的后端组合

策略核心是导出可复用的，别的后端大约二十行就能接入：

```js
import { RapidRefillTracker } from 'dsh-zcode-breaker/tracker';

const tracker = new RapidRefillTracker({ toolTurnThreshold: 2, maxConsecutiveRapidRefills: 3 });
tracker.noteToolTurn();
const gate = tracker.gate();
if (gate.blocked) throw new Error('rapid refill loop');
const result = await myEngine.compact();
if (result !== null) tracker.commitCompaction(gate.projectedConsecutiveRapidRefills);
```

## 测试

```bash
npm test
```

**19 个测试**、**2 个测试套件**，不需要任何服务、模型或会话：策略核心在 `test/tracker.test.js`，引擎接线在 `test/engine.test.js`。接线那套需要 peer 包可解析，解析不到时会跳过而不是失败。

## 路线图

- 跑模型驱动的验收：在真实会话里造出回填循环，看熔断真的跳闸。
- 支持运行时选择父类，从而与用户偏好的任意后端组合。
- 把策略核心提给上游 `@deepseek-ai/dsh-compaction-basic`。

## 许可

MIT
