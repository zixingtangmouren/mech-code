# Core README 重写设计

## 目标

重写 `packages/core/README.md` 与 `packages/core/README.zh-CN.md`，为 `@mech-code/core` 的 SDK 使用者提供准确、可操作且便于日常查阅的实用手册。两份文档信息等价，分别使用自然英文与自然中文表达。

## 受众与边界

- 主要受众是准备在 Node.js 或 Bun 应用中集成 `@mech-code/core` 的 TypeScript/JavaScript 开发者。
- 文档只承诺 `packages/core/src/index.ts` 公开导出的能力。
- 不介绍当前未从包入口导出的 MCP 客户端、Skills 注册表等内部模块。
- 不混入 Mech-Code CLI 的安装、配置或终端操作说明。
- 不重复源码中的所有类型细节，只保留完成常见任务所需的信息，并以精简索引帮助用户继续探索。

## 内容组织

README 采用任务驱动结构：

1. 包定位、运行环境与安装方式。
2. 一个可直接运行的最小 Agent 示例。
3. Agent 运行模型，包括调用方持有的 `AgentState`、`run()`、`complete()` 与多轮会话。
4. Anthropic、OpenAI 和 OpenAI-compatible Provider 的选择与配置。
5. 使用 Zod 或 JSON Schema 定义工具，以及工具标记和动态注册。
6. 中间件的生命周期 Hook、调用包装和状态扩展。
7. 流式事件、中止和统一 Provider 错误。
8. Human-in-the-loop 的暂停、checkpoint 与恢复流程。
9. 多模态消息、状态序列化、Agent 派生等进阶能力。
10. 精简的公开 API 索引和仓库内示例入口。

## 示例策略

- 快速开始示例必须包含所有 import，并避免引用未声明变量。
- 示例优先展示用户需要掌握的完整数据流：创建 Provider、定义工具、创建 Agent、维护 State、运行 Agent。
- 单项示例保持短小，只突出当前章节的 API。
- Provider 模型名使用明确的占位符，避免把可能过期的具体模型版本描述为默认值。
- 所有方法名、参数结构、返回值和事件类型均以当前源码与公开类型为准。

## 双语一致性

- 英文版与中文版使用相同的章节顺序、代码示例和能力范围。
- 标题、说明和表格采用各自语言的自然表达，不进行逐句直译。
- 两份 README 顶部互相链接。

## 验证

- 对照 `packages/core/src/index.ts` 检查文档中的每个公开导入。
- 将主要 TypeScript 代码块提取到临时文件并执行类型检查，确认示例与当前 API 一致。
- 执行仓库要求的 `pnpm typecheck`、`pnpm lint`、`pnpm test` 和 `pnpm build`。
- 检查中英文 README 的章节、代码块和链接是否对应且完整。
