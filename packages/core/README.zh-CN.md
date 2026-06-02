# @mech-code/core

[English](./README.md)

`@mech-code/core` 是 Mech-Code 的 SDK 核心包，包含 Agent 循环引擎、多模型 Provider、工具协议、中间件管道等全部运行时能力。它不依赖终端/UI，可运行于 Node.js、Bun 等任意 JS 运行时。

## 安装

```bash
npm install @mech-code/core
# 或
pnpm add @mech-code/core
```

---

## 快速开始

```ts
import { createAgent, AnthropicProvider, defineTool } from '@mech-code/core'
import { z } from 'zod'

// 1. 定义工具
const readFileTool = defineTool({
  name: 'read_file',
  description: '读取指定路径的文件内容',
  schema: z.object({ path: z.string().min(1) }),
  flags: { readonly: true, parallelSafe: true },
  async execute({ path }) {
    const content = await fs.promises.readFile(path, 'utf-8')
    return { content }
  },
})

// 2. 创建 Provider
const provider = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: 'claude-sonnet-4-20250514',
})

// 3. 创建 Agent
const agent = createAgent({
  provider,
  tools: [readFileTool],
  system: 'You are a helpful coding assistant.',
})

// 4. 创建会话状态（由调用方持有，跨轮次持续累积）
const state = createAgentState()
state.messages.push({ role: 'user', content: 'Hello!' })

// 5. 流式运行
for await (const event of agent.run({ state })) {
  if (event.type === 'text_delta') process.stdout.write(event.delta)
}
// 此时 state.messages 已包含完整的对话历史

// 或一次性获取最终结果
const result = await agent.complete({ state })
console.log(result.text) // result: { text, stopReason, usage, turnsUsed }
```

---

## Provider

Provider 负责与 LLM 厂商 API 通信，将统一的内部消息格式序列化为厂商请求体，并将响应归一化为标准格式。

### 内置 Provider

| Provider                   | 说明                                            |
| -------------------------- | ----------------------------------------------- |
| `AnthropicProvider`        | Anthropic 原生 API（Claude）                    |
| `OpenAIProvider`           | OpenAI 原生 API                                 |
| `OpenAICompatibleProvider` | 通用兼容协议，覆盖 DeepSeek、Ollama 等 90% 厂商 |

### 配置（`ProviderConfig`）

```ts
interface ProviderConfig {
  apiKey: string
  model: string
  baseUrl?: string // 自定义端点（代理、本地模型等）
  headers?: Record<string, string> // 附加请求头
  defaultParams?: ModelParams // 默认生成参数
}
```

### 生成参数（`ModelParams`）

```ts
interface ModelParams {
  temperature?: number
  maxTokens?: number
  topP?: number
  stopSequences?: string[]
  extra?: Record<string, unknown> // 厂商特定参数逃生口
}
```

`defaultParams` 在构造 Provider 时设置，可被单次调用的 `CallOptions.modelParams` 覆盖（浅合并）。

### 非流式调用

```ts
const response = await provider.chat(params, { modelParams: { temperature: 0.7 } })
// response: { content, usage, stopReason }
```

### 流式调用（`StreamResult`）

`provider.stream()` 返回一个双通道对象，同时提供逐事件消费和最终结果：

```ts
const { stream, final, abort } = provider.stream(params)

// 消费事件流（用于 UI 实时渲染）
for await (const event of stream) {
  process.stdout.write(event.type === 'text_delta' ? event.delta : '')
}

// 等待完整响应（Agent Loop 使用）
const { content, usage, stopReason } = await final
```

### 错误处理（`ProviderError`）

所有 Provider 将厂商错误统一翻译为 `ProviderError`：

```ts
import { ProviderError } from '@mech-code/core'

try {
  await provider.chat(params)
} catch (err) {
  if (err instanceof ProviderError) {
    console.log(err.code) // 'auth_failed' | 'rate_limited' | 'server_error' | ...
    console.log(err.retryable) // 是否可重试
    console.log(err.provider) // provider 名称
  }
}
```

| 错误码             | 说明               | 可重试 |
| ------------------ | ------------------ | ------ |
| `auth_failed`      | 401 / 403 鉴权失败 | 否     |
| `rate_limited`     | 429 限流           | 是     |
| `context_too_long` | 上下文超限         | 否     |
| `model_not_found`  | 模型不存在         | 否     |
| `server_error`     | 5xx 服务端错误     | 是     |
| `network_error`    | 网络层异常         | 是     |
| `invalid_request`  | 4xx 参数错误       | 否     |
| `aborted`          | 用户主动中止       | 否     |

---

## 工具系统

### 定义工具（`defineTool`）

推荐使用 **Zod schema 方式**，可获得完整类型安全和自动输入校验：

```ts
import { defineTool } from '@mech-code/core'
import { z } from 'zod'

const searchTool = defineTool({
  name: 'search',
  description: '在代码库中搜索文本',
  schema: z.object({
    query: z.string().min(1, '搜索词不能为空'),
    path: z.string().optional(),
  }),
  flags: {
    readonly: true, // 无副作用，权限中间件可自动放行
    parallelSafe: true, // 可并发执行
  },
  // input 类型由 schema 自动推导，无需手动转型
  async execute({ query, path }, ctx) {
    // ctx: { cwd, signal, metadata }
    return { content: `搜索结果: ...` }
  },
  // 可选：额外的业务约束校验（在 Zod 校验通过后执行）
  validateInput({ query }) {
    if (query.length > 200) return { valid: false, error: '搜索词过长' }
    return { valid: true }
  },
  // 可选：动态生成注入 system prompt 的工具描述
  getPrompt({ cwd }) {
    return `当前工作目录: ${cwd}`
  },
})
```

也可使用**原始 JSON Schema 方式**（适合接入 MCP 工具或不依赖 Zod 的场景）：

```ts
const tool = defineTool({
  name: 'read_file',
  description: '读取文件',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  flags: { readonly: true, parallelSafe: true },
  async execute(input) {
    const path = input['path'] as string // 需要手动转型
    return { content: '...' }
  },
})
```

### 工具标记（`ToolFlags`）

```ts
interface ToolFlags {
  readonly: boolean // true = 无副作用，权限中间件可自动放行，跳过用户确认
  parallelSafe: boolean // true = Loop 调度器可将多个 tool_use 并发执行
}
```

### 工具注册表

```ts
import { registerTool, getTool, getAllTools, getToolDefinitions, clearTools } from '@mech-code/core'

registerTool(searchTool)

getTool('search') // 按名称获取
getAllTools() // 获取所有已注册工具
getToolDefinitions() // 获取发送给 LLM 的精简定义列表（name + description + inputSchema）
clearTools() // 清空注册表（测试时使用）
```

---

## 中间件

中间件以可插拔方式扩展 Agent 行为，处理重试、限流、权限、日志等横切逻辑，不侵入核心代码。支持两种模式：

- **Hook 模式** —— 读写 Context 状态（日志、上下文压缩、token 计量）
- **Wrap 模式** —— 包裹核心操作（重试、缓存、熔断、权限拦截）

职责边界：**Hook 只做状态读写，Wrap 只做行为包裹**，不混合。

### 中间件接口

```ts
interface AgentMiddleware {
  name: string
  /** 默认共享状态：合并到 AgentState.store，其他中间件和工具可读写，支持持久化 */
  store?: Record<string, unknown>

  // === Hook 模式：状态观察与修改 ===
  beforeAgent?(ctx: RunContext): Awaitable<void> // run 开始，做初始化
  afterAgent?(ctx: RunContext): Awaitable<void> // run 结束，类似 finally
  beforeModel?(ctx: RunContext): Awaitable<void> // 修改 callMessages / system / tools
  afterModel?(ctx: RunContext): Awaitable<void> // 观察模型输出，更新统计

  // === Wrap 模式：包裹核心操作 ===
  wrapModelCall?(next: ModelCallFn, ctx: RunContext): Awaitable<StreamResult>
  wrapToolCall?(next: ToolCallFn, ctx: ToolCallContext): Awaitable<ToolOutput>
}
```

对于有状态的中间件，推荐继承 `Middleware` 基类：

```ts
import { Middleware } from '@mech-code/core'

class TokenCounterMiddleware extends Middleware {
  name = 'token-counter'

  // 默认共享状态：运行时会绑定到 AgentState.store
  store = { totalInputTokens: 0, totalOutputTokens: 0 }

  // 私有状态：仅自身可见
  private threshold = 100_000

  afterModel(ctx: RunContext) {
    const { inputTokens, outputTokens } = ctx.lastResponse!.usage
    this.store.totalInputTokens += inputTokens
    this.store.totalOutputTokens += outputTokens
    if (this.store.totalInputTokens > this.threshold) {
      console.warn('累计 input token 已超过阈值')
    }
  }
}
```

### `RunContext` —— 中间件的读写视图

```ts
interface RunContext {
  state: AgentState // 完整会话状态（可变引用，修改会持久化）
  callMessages: Message[] // 本轮发给模型的消息快照（beforeModel 可改写）
  system: string // 本轮 system prompt（beforeModel 可追加）
  tools: ToolDefinition[] // 本轮工具列表（beforeModel 可动态增减）
  lastResponse?: ChatResponse // afterModel 阶段可读（只读观察点）
  readonly turnIndex: number
  readonly signal: AbortSignal
}
```

`state` 是持久化的唯一真相，对其的修改跨轮次保留。`callMessages` 是每轮的临时投影，中间件修改只影响本次模型调用，不污染历史记录。`afterModel` 中的 `lastResponse` 是只读观察点，不应修改模型输出内容。

### 示例：日志中间件（Hook 模式）

```ts
import type { AgentMiddleware } from '@mech-code/core'

const loggerMiddleware: AgentMiddleware = {
  name: 'logger',
  beforeModel(ctx) {
    console.log(`[Turn ${ctx.turnIndex}] 发送 ${ctx.callMessages.length} 条消息`)
  },
  afterModel(ctx) {
    const { inputTokens, outputTokens } = ctx.lastResponse!.usage
    console.log(`[Turn ${ctx.turnIndex}] token: ${inputTokens} in / ${outputTokens} out`)
  },
}
```

### 示例：重试中间件（Wrap 模式）

```ts
const retryMiddleware: AgentMiddleware = {
  name: 'retry',
  async wrapModelCall(next, ctx) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await next(ctx)
      } catch (e) {
        if (!(e instanceof ProviderError) || !e.retryable || attempt === 2) throw e
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
      }
    }
    throw new Error('unreachable')
  },
}
```

### 示例：权限中间件（Wrap 模式）

```ts
const permissionMiddleware: AgentMiddleware = {
  name: 'permission',
  async wrapToolCall(next, ctx) {
    const tool = getTool(ctx.toolName)
    // 只读工具自动放行，写操作工具需要用户确认
    if (!tool?.flags.readonly) {
      const confirmed = await askUser(`是否允许执行工具 "${ctx.toolName}"？`)
      if (!confirmed) return { content: '用户已拒绝此操作', isError: true }
    }
    return next(ctx)
  },
}
```

### 在 Agent 中注册中间件

```ts
const agent = createAgent({
  provider,
  tools: [searchTool, readFileTool],
  middleware: [new TokenCounterMiddleware(), retryMiddleware, permissionMiddleware],
})

// 或在创建后动态追加
agent.use(myMiddleware)
```

---

## 消息协议

### 外部消息格式（面向使用者）

```ts
type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | UserContentBlock[] } // 支持多模态
  | { role: 'assistant'; content: string | AssistantContentBlock[] }
  | { role: 'tool'; toolCallId: string; content: string }
```

### 多模态输入

```ts
const messages: Message[] = [
  {
    role: 'user',
    content: [
      { type: 'text', text: '这张图里有什么？' },
      { type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } },
    ],
  },
]
```

### 消息工具函数

```ts
import {
  normalizeMessage,
  normalizeMessages,
  denormalizeMessage,
  estimateTokens,
} from '@mech-code/core'

// 外部 Message → 内部规范化格式（字符串内容转为内容块数组）
const internal = normalizeMessage({ role: 'user', content: 'Hello' })

// 估算 token 数（基于字符数的快速近似，无需调用 API）
const tokens = estimateTokens('Hello, world!')
```

---

## Agent

### 创建 Agent

```ts
import { createAgent, createAgentState } from '@mech-code/core'

const agent = createAgent({
  provider,            // LLMProvider 实例（必填）
  tools: [...],        // 可用工具列表
  system: '...',       // 系统提示词
  middleware: [...],   // 中间件列表
  maxTurns: 20,        // 最大循环轮数（默认 20）
  cwd: process.cwd(),  // 工具执行的工作目录
})
```

### 实例方法

```ts
// 核心执行
agent.run(params) // AsyncIterable<AgentEvent> —— 流式消费事件
agent.complete(params) // Promise<RunResult> —— 等待最终结果

// 运行时变更
agent.use(middleware) // 追加中间件
agent.addTool(tool) // 动态注册工具
agent.removeTool('name') // 动态移除工具
agent.fork(overrides) // 基于当前 Agent 派生新实例（覆盖部分配置）
```

### State —— 由调用方持有

Agent 会话状态由调用方持有并传入每次 `run()`。Agent 在执行过程中直接修改此对象（追加消息、累加用量），调用方无需手动同步结果。

```ts
const state = createAgentState()
// 等价于：{ messages: [], usage: { inputTokens: 0, outputTokens: 0 }, store: {} }

// 第一轮对话
state.messages.push({ role: 'user', content: '列出 src/ 下的文件' })
for await (const event of agent.run({ state, signal: abortController.signal })) {
  // AgentEvent: agent_run_start | turn_start | text_delta | tool_executing | ... | agent_run_end
}

// 第二轮对话 —— 同一个 state 继续
state.messages.push({ role: 'user', content: '解释一下 loop.ts 的实现' })
const result = await agent.complete({ state })
console.log(result.text) // 本次 assistant 的文本输出
console.log(result.turnsUsed) // 本次 run 用了几轮
console.log(result.stopReason) // 'end_turn' | 'max_turns' | 'error' | 'abort'
```

### fork 派生子任务 Agent

```ts
// 主 Agent 拥有全部工具
const mainAgent = createAgent({ provider, tools: allTools })

// 派生只读子 Agent（摘要任务不需要写工具）
const summaryAgent = mainAgent.fork({
  tools: readOnlyTools,
  system: '你是一个摘要助手，只需阅读和总结内容。',
  maxTurns: 3,
})
```

---

## 类型导出速查

| 导出名                                     | 说明                                          |
| ------------------------------------------ | --------------------------------------------- |
| `createAgent` / `Agent`                    | Agent 工厂与类                                |
| `createAgentState`                         | 创建空的 `AgentState`                         |
| `AgentState` / `AgentMessage`              | 会话状态类型                                  |
| `RunParams` / `RunResult`                  | Agent 运行参数与结果                          |
| `RunContext` / `ToolCallContext`           | 中间件上下文类型                              |
| `ModelCallFn` / `ToolCallFn` / `Awaitable` | Wrap 模式中间件函数类型                       |
| `Middleware`                               | 有状态中间件基类                              |
| `MiddlewarePipeline`                       | 管道执行器（进阶使用）                        |
| `AnthropicProvider`                        | Anthropic Provider                            |
| `OpenAIProvider`                           | OpenAI Provider                               |
| `OpenAICompatibleProvider`                 | 兼容 OpenAI 协议的通用 Provider               |
| `ProviderError`                            | 统一错误类                                    |
| `defineTool`                               | 工具定义工厂                                  |
| `registerTool` / `getTool` / `getAllTools` | 工具注册表操作                                |
| `normalizeMessage` / `denormalizeMessage`  | 消息格式转换                                  |
| `estimateTokens`                           | Token 数快速估算                              |
| `Message` / `AgentEvent` / `Usage`         | 共享类型（来自 `@mech-code/shared` 的再导出） |
