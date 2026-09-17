# dsh-novel

**状态：规划中 · Status: planned.** 本仓库用于开发 DSH 的长篇小说创作插件，目前尚无可用版本。

## 计划做什么

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）提供**长篇连载**写作支持——重点不在"生成一段文字"，而在长篇特有的一致性问题：

- **分卷与章节结构**：大纲、卷/章/节的组织与进度跟踪
- **人物与设定卡片**：角色、地点、物品的属性与出场记录
- **伏笔台账**：埋设点与回收点的登记、未回收提醒
- **一致性检查**：新章节与前文的冲突提示（设定矛盾、人物状态错位）
- **写作提示词模式**：配合 [dsh-custom-mode](https://github.com/BOWLUNA/dsh-custom-mode) 的可编辑系统提示词

## 形态

一个 dsh 插件（`dsh.bundle` + 可选 `dsh.client` 设置页）。**零依赖、源码即产物**，与本账号下其他 dsh 插件保持同一工程约定。

## License

MIT
