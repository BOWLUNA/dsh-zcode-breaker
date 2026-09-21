# 实测记录

[English](MEASUREMENTS.md) | 简体中文

本仓库里每一条主张都由命令与原始输出支撑。这里汇总要紧的那些实测，包括两项还没完成的。

## 环境

| 项 | 值 |
| --- | --- |
| Harness | DeepSeek Harness 0.1.5-rc.2，桌面发行版 |
| 使用的启动 | 隔离 `DSH_HOME` 里的 `--profile web --port 31901 --no-open` |
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

## 还没测的部分

- 模型驱动的验收：还没有任何会话产生过真实的压缩压力，所以熔断跳闸从未被端到端观察到。它需要一个有效的模型凭证，而这台机器上没有。
- 命令在 web UI 里的渲染。它的文本契约就是框架给斜杠命令的那套，内容也由套件断言过；没被观察到的只有渲染。
