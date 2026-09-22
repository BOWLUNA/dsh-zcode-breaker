# 实测记录

[English](MEASUREMENTS.md) | 简体中文

本仓库里每一条主张都由命令与原始输出支撑。这里汇总要紧的那些实测，包括两项还没完成的。

## 环境

| 项 | 值 |
| --- | --- |
| Harness | DeepSeek Harness 0.1.5-rc.2，桌面发行版 |
| 使用的启动 | 隔离 `DSH_HOME` 里的 `--profile web --port 32100 --no-open`（早期运行用过 31901） |
| 使用的凭证 | 无，因为创建 agent 不会调用模型 |
| 套件结果 | 19 个测试、2 个套件、0 失败 |

## 域里服务的就是本引擎

用与会话控制器相同的那两次调用挂载 preset 域，再从域内部把服务读回来：

```text
realm-probe-apply-ran
compaction-service-constructor=BreakerCompactionEngine
typeof-compactIfNeeded=function
typeof-compactNow=function
engine-config={"auto":true,"thresholdRatio":0.8,"maxTokens":8192}
breaker-methods={"trippedFor":"function","statusFor":"function"}
```

从域外读同一个服务则读不到，这正是隔离所声明的语义，也正是它阻止了宿主平面的监听者冒充引擎。

## 私有字段读取曾在压缩路径里抛错

在同一份探针上，把状态搬出私有字段之前：

```text
breaker-policy-read-failed=Cannot read private member #breaker from an object whose class did not declare it
trippedFor-threw=Cannot read private member #trackers from an object whose class did not declare it
same-class-identity-as-repo-copy=true
public-own-props=["ctx","name","config","warnedPressureConfigTargets","overflowRetries","overflowAgents"]
```

被交出来的对象带着本类的 prototype 与父类的自有字段，却不带本类任何一个私有品牌。又因为宿主会捕获从自动压缩路径抛出的错误，这个失败只会静默地把自动压缩关掉，不会报告任何东西。

## 修复之后

```text
breaker-policy={"toolTurnThreshold":2,"maxConsecutiveRapidRefills":3,"announceInPrompt":true}
works-trips-private-state=false
public-own-props=["ctx","name","config","warnedPressureConfigTargets","overflowRetries","overflowAgents","breakerPolicy"]
```

被交出来的对象上，公开 API 可以调用，解析后的策略也读得到。

## 一次真实模型会话，以及它走到了哪一步（2026-09-22）

这是「跳闸」离被观察到最近的一次，而这里如实报告它本来的样子：**压力路径确实在一次次调用本引擎 —— 在一个真实会话里 —— 但至今没有任何一次压缩成功，所以跳闸仍未被观察到。**

实验室是本仓库**自己的实例**（`C:/Users/BOWLUNA/Desktop/DSHTEST/breaker`，dsh `0.1.6-alpha.2`），由一个探针驱动：它用生产会话路径的那**两个公开调用**把域组合起来，然后包住 `compactIfNeeded` —— 是**观察者，不是模拟器**。决策没有任何一处被伪造；记录到的每一次调用都来自宿主自己的 `agent/pre-step` 压力路径。

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

这确立了三条此前只是**假设**的事实：

- **宿主的压力路径在真实会话里会调用本引擎。** 七次 `compactIfNeeded` 调用**全部**带着 `trigger=pressure` 到达；没有别的调用方。
- **配置真的到了引擎。** armed 那行报出的就是本实验室设的值（`7` 个工具轮次、`0.5`），与默认值不同 —— 所以这条管线不是靠猜的。
- **`agent.ctx.get("compaction")` 拿到的那个引擎是宿主平面的**，不是 preset 行那个：它的 `config` 报的是宿主默认值，而 preset 行报的是 `0.5`。**类名区分不了两者**，因为两个平面跑的是同一个类 —— 所以本文档早先那个以「构造函数名字」当作「域里服务的就是本引擎」证据的版本，比它读起来要弱。上面已更正。

为什么没跳闸，精确地说：只有当 `super.compactIfNeeded` **返回结果**时，熔断器才会记录一个压缩点。而这里每一次尝试，基类都抛了 —— 要么摘要不比被它遮蔽的内容更小，要么两次尝试之后总量仍高于阈值。压缩点一个都没记下，`consecutiveRapidRefills` 就永远推不动，拒绝也永远到不了。这次会话**确实**产生的循环是一个**失败**循环，不是快速回填循环。

所以剩余条件很窄、也可测：要有一个会话，其可压缩区域大到让摘要的输出严格更小，同时阈值明显高于**不可压缩的基线**（这里光是 preset 的指令就近 20k token）。该实验的脚手架已经就位，并记录在台账里。

## 还没测的部分

- **跳闸本身。** 上一节是它离得最近的一次；还没有任何会话产生过「一次成功的压缩 + 随后的连续快速回填」。见台账的 `issues/01`。
- 命令在 web UI 里的渲染。它的文本契约就是框架给斜杠命令的那套，内容也由套件断言过；没被观察到的只有渲染。

