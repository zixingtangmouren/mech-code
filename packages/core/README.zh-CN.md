# @mech-code/core

[English](./README.md)

`@mech-code/core` 是 Mech-Code 的无 UI Agent 运行时。你可以用它构建终端智能体、后台任务、Web 服务或自己的对话界面，并通过统一模型管理 Provider、工具、会话状态、流式事件、中间件和人工审批。

该包仅提供 ESM 版本，需要运行环境支持 `fetch`、`AbortController` 和 `structuredClone`。下文示例使用 Node.js 和 TypeScript。

## 安装

```bash
pnpm add @mech-code/core zod
# 或
npm install @mech-code/core zod
```

只有使用推荐的类型安全工具定义 API 时才需要 Zod。你也可以直接用 JSON Schema 定义工具。

## 快速开始

下面的示例连接一个兼容 OpenAI 协议的端点，为 Agent 提供一个只读工具，并流式输出模型回复：

```ts
import { readFile } from 'node:fs/promises'
import {
  OpenAICompatibleProvider,
  UserMessage,
  createAgent,
  createAgentState,
  defineTool,
} from '@mech-code/core'
import { z } from 'zod'

const readFileTool = defineTool({
  name: 'read_file',
  description: '读取 UTF-8 文本文件',
  schema: z.object({ path: z.string().min(1) }),
  flags: { readonly: true, parallelSafe: true },
  async execute({ path }) {
    return { content: await readFile(path, 'utf8') }
  },
})

const provider = new OpenAICompatibleProvider({
  apiKey: process.env.LLM_API_KEY ?? '',
  baseUrl: process.env.LLM_BASE_URL ?? 'http://localhost:11434/v1',
  model: process.env.LLM_MODEL ?? 'qwen2.5-coder:7b',
})

const agent = createAgent({
  provider,
  tools: [readFileTool],
  system: '你是一名回答简洁的编程助手。',
})

const state = createAgentState()
state.messages.push(new UserMessage('总结 package.json'))

for await (const event of agent.run({ state, props: { cwd: process.cwd() } })) {
  if (event.type === 'text_delta') process.stdout.write(event.delta)
}
```

`agent.run()` 会直接修改 `state`。运行结束后，其中包含 Assistant 消息、工具结果和累计 token 用量。下一轮对话继续复用这个对象即可。

## Agent 如何运行

一个 Agent 由一个 Provider、系统提示词、一组工具、可选中间件和循环轮数上限组成：

```ts
const agent = createAgent({
  provider,
  tools: [readFileTool],
  middleware: [],
  system: '你是一名编程助手。',
  maxTurns: 20,
})
```

会话状态由调用方持有。每次运行前加入一条新的 `UserMessage`，并持续传入同一个 state，就能延续对话：

```ts
const state = createAgentState()

state.messages.push(new UserMessage('列出主要模块。'))
await agent.complete({ state })

state.messages.push(new UserMessage('哪个模块负责执行工具？'))
const result = await agent.complete({
  state,
  props: { cwd: process.cwd(), requestId: 'req-42' },
})

console.log(result.text)
console.log(result.stopReason)
console.log(result.usage)
```

`props` 用于向中间件和工具传递只读、仅在本次 run 中有效的数据，不会保存到 checkpoint。

根据输出消费方式选择执行方法：

| 方法                     | 适用场景                                                                      |
| ------------------------ | ----------------------------------------------------------------------------- |
| `agent.run(params)`      | 需要 `AsyncIterable<AgentEvent>` 来实时渲染文本、展示工具进度或获取状态快照。 |
| `agent.complete(params)` | 只需要最终 `RunResult`：文本、停止原因、本次用量、运行轮数和 checkpoint。     |
| `agent.resume(params)`   | 根据人工审批 checkpoint 继续执行尚未完成的工具调用。                          |

默认最多执行 20 个模型轮次。可以在创建 Agent 时通过 `maxTurns` 修改，也可以在单次运行中通过 `config.maxTurns` 覆盖。

### 取消运行

传入 `AbortSignal` 即可进行协作式取消：

```ts
import { ProviderError } from '@mech-code/core'

const controller = new AbortController()

const running = agent.complete({
  state,
  config: { signal: controller.signal },
})

controller.abort('user_cancelled')

try {
  await running
} catch (error) {
  if (!(error instanceof ProviderError) || error.code !== 'aborted') throw error
}
```

Provider 的底层 `StreamResult` 也提供 `abort()`。在 Agent 层建议传入 run signal，使同一个取消信号能够传递给 Provider、中间件和工具。

### 运行时调整与派生

```ts
agent.addTool(readFileTool)
agent.removeTool('read_file')
agent.use(loggingMiddleware)

const reviewAgent = agent.fork({
  tools: [readFileTool],
  system: '只审查代码，不修改文件。',
  maxTurns: 5,
})
```

`fork()` 会复制当前 Agent 配置，并应用传入的覆盖项。会话状态仍需单独传入。

## 选择 Provider

所有内置 Provider 都实现相同的 `LLMProvider` 接口，并统一消息、工具调用、流式事件、用量和错误格式。

| Provider                   | 适用场景                                                |
| -------------------------- | ------------------------------------------------------- |
| `AnthropicProvider`        | Anthropic 原生 Messages API。                           |
| `OpenAIProvider`           | OpenAI Chat Completions 或 Responses API。              |
| `OpenAICompatibleProvider` | DeepSeek、Ollama、vLLM 等第三方或本地 OpenAI 兼容端点。 |

```ts
import { AnthropicProvider, OpenAICompatibleProvider, OpenAIProvider } from '@mech-code/core'

const anthropic = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: process.env.ANTHROPIC_MODEL!,
})

const openai = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: process.env.OPENAI_MODEL!,
  protocol: 'responses',
})

const local = new OpenAICompatibleProvider({
  apiKey: 'unused',
  baseUrl: 'http://localhost:11434/v1',
  model: 'qwen2.5-coder:7b',
})
```

Provider 构造函数接受以下配置：

```ts
interface ProviderConfig {
  apiKey: string
  model: string
  baseUrl?: string
  protocol?: 'chat' | 'responses'
  headers?: Record<string, string>
  timeoutMs?: number
  defaultParams?: {
    temperature?: number
    maxTokens?: number
    topP?: number
    stopSequences?: string[]
    extra?: Record<string, unknown>
  }
}
```

`protocol` 适用于 OpenAI 风格的 Provider，默认为 `chat`。代理或自定义端点通过 `baseUrl` 设置。请求默认在 300000 毫秒后超时；`timeoutMs` 可以设置 Provider 默认值，也可以在单次调用中覆盖。直接调用 `provider.chat()` 或 `provider.stream()` 时，单次调用的 `modelParams` 会浅合并覆盖 `defaultParams`。

```ts
const response = await openai.chat(
  { messages: [new UserMessage('打个招呼。')] },
  { modelParams: { temperature: 0.2, maxTokens: 100 }, timeoutMs: 60_000 },
)

const { stream, final, abort } = openai.stream({
  messages: [new UserMessage('解释这个 API。')],
})
```

`stream` 生成统一事件，`final` 解析为完整的 `ChatResponse`，`abort()` 用于取消请求。

## 定义工具

工具由名称、描述、输入 schema、执行函数和两个调度/策略标记组成。使用 Zod 可以获得自动推导的输入类型和运行时校验：

```ts
import { defineTool } from '@mech-code/core'
import { z } from 'zod'

const searchTool = defineTool({
  name: 'search',
  description: '搜索项目中的文本文件',
  schema: z.object({
    query: z.string().min(1),
    path: z.string().default('.'),
  }),
  flags: {
    readonly: true,
    parallelSafe: true,
  },
  validateInput({ query }) {
    return query.length <= 200 ? { valid: true } : { valid: false, error: '搜索内容过长' }
  },
  async execute({ query, path }, context) {
    return {
      content: `在 ${path} 中搜索 ${query}`,
      metadata: { requestId: context.runtime.props.requestId },
    }
  },
})
```

- `readonly` 表示工具是否有副作用。Core 不会自行执行权限策略，中间件可以根据这个标记判断是否需要审批。
- `parallelSafe` 允许 Agent Loop 并发执行对该工具的多个调用。未设置该标记的调用会串行执行。
- `content` 会返回给模型。可选的 `metadata` 用于携带宿主侧结构化数据，不会作为普通文本发送给模型。

已有 JSON Schema 时，可以使用原始定义方式：

```ts
const rawTool = defineTool({
  name: 'lookup',
  description: '查询一个值',
  inputSchema: {
    type: 'object',
    properties: { key: { type: 'string' } },
    required: ['key'],
    additionalProperties: false,
  },
  flags: { readonly: true, parallelSafe: true },
  execute(input) {
    return { content: String(input.key) }
  },
})
```

输入校验失败时，Core 会生成模型可读取的错误工具结果。工具执行期间抛出的异常仍属于执行错误。

### 工具注册表

包中还提供了进程级工具注册表：

```ts
import { getAllTools, getTool, registerTool } from '@mech-code/core'

registerTool(searchTool)
getTool('search')

const agent = createAgent({ provider, tools: getAllTools() })
```

注册工具不会自动修改已有 Agent。需要把注册表中的工具传给 `createAgent()`，或通过 `agent.addTool()` 添加。

## 添加中间件

中间件用于封装横切逻辑，无需修改 Agent Loop。它提供两种互补模式：

- 生命周期 Hook（`beforeAgent`、`afterAgent`、`beforeModel`、`afterModel`）用于观察或更新一次 run 或模型轮次前后的状态。
- 调用包装器（`wrapModelCall`、`wrapToolCall`）拦截一次真实的 Provider 或工具调用，适合重试、缓存、降级、权限和结果处理。

大多数场景可以使用简洁的 `createMiddleware()`。默认状态会经过克隆后合并到调用方的 `AgentState`，且不会覆盖已有字段：

```ts
import { createMiddleware } from '@mech-code/core'

const loggingMiddleware = createMiddleware({
  name: 'logging',
  state: { modelCalls: 0 },
  beforeModel(ctx) {
    const modelCalls = Number(ctx.state.modelCalls) + 1
    ctx.state.modelCalls = modelCalls
    ctx.runtime.emitCustomAgentEvent({
      source: 'logging',
      name: 'model_call_counted',
      payload: { modelCalls },
    })
    console.log('turn', ctx.runtime.turnIndex)
  },
  async wrapToolCall(request, handler) {
    const startedAt = Date.now()
    const output = await handler(request)
    return {
      ...output,
      metadata: { ...output.metadata, durationMs: Date.now() - startedAt },
    }
  },
})

const agent = createAgent({
  provider,
  middleware: [loggingMiddleware],
})
```

中间件可以声明 `tools`，将行为、状态和可调用工具封装成一个独立能力。Agent 配置和中间件之间出现重复工具名时，Core 会直接报错。

需要使用带私有运行时字段的 class 时，可以继承 `Middleware` 基类。包中也为高级集成导出了 `MiddlewarePipeline`，普通应用应优先通过 Agent 注册中间件。

## 消费事件与处理错误

`agent.run()` 和 `agent.resume()` 都会生成统一的 `AgentEvent` 联合类型。常用事件分为：

| 事件                                                                          | 含义                        |
| ----------------------------------------------------------------------------- | --------------------------- |
| `agent_run_start`、`agent_run_end`、`turn_start`、`turn_end`                  | run 和模型轮次生命周期。    |
| `reasoning_start`、`reasoning_content`、`reasoning_end`                       | 模型推理的流式输出。        |
| `text_start`、`text_delta`、`text_end`                                        | Assistant 文本的流式输出。  |
| `tool_start`、`tool_input_delta`、`tool_executing`、`tool_result`、`tool_end` | 工具调用进度和结果。        |
| `custom`                                                                      | 可序列化的中间件事件。      |
| `suspended`                                                                   | 等待外部决策的 checkpoint。 |

使用可辨识联合类型的 switch 可以完整处理事件：

```ts
for await (const event of agent.run({ state })) {
  switch (event.type) {
    case 'text_delta':
      process.stdout.write(event.delta)
      break
    case 'tool_executing':
      console.error(`正在执行 ${event.toolName}`)
      break
    case 'agent_run_end':
      console.error(`停止原因：${event.stopReason}`)
      break
  }
}
```

所有内置 Provider 都会把 API 异常转换为统一的 `ProviderError`：

```ts
import { ProviderError } from '@mech-code/core'

try {
  await agent.complete({ state })
} catch (error) {
  if (error instanceof ProviderError) {
    console.error(error.provider, error.code, error.retryable, error.requestId)
  } else {
    throw error
  }
}
```

| 错误码                                                                                                       | 可重试 |
| ------------------------------------------------------------------------------------------------------------ | ------ |
| `rate_limited`、`timeout`、`overloaded`、`server_error`、`network_error`                                     | 是     |
| `auth_failed`、`permission_denied`、`billing_error`、`quota_exceeded`、`context_too_long`、`model_not_found` | 否     |
| `not_found`、`request_too_large`、`conflict`、`invalid_response`、`invalid_request`、`aborted`、`unknown`    | 否     |

厂商提供相应信息时，`ProviderError` 还会包含 `status`、`vendorCode`、`requestId` 和 `retryAfterMs`。应用逻辑应读取 `error.retryable`，不要自行写死这张表；有 `retryAfterMs` 时应优先遵循，再使用指数退避。实现流式 Provider 调用的重试中间件时，还可以使用导出的 `retryStreamResult()` 辅助函数。

## 等待人工审批

工具包装器可以抛出 `SuspendSignal`，在敏感操作执行前暂停。Agent 会返回一个可序列化 checkpoint，其中包含所有尚未完成的工具调用：

```ts
import { SuspendSignal, createMiddleware } from '@mech-code/core'

const sensitiveTools = new Set(['write_file', 'run_command'])

const approvalMiddleware = createMiddleware({
  name: 'approval',
  async wrapToolCall(request, handler) {
    if (!sensitiveTools.has(request.toolName) || request.context.runtime.props.approved === true) {
      return handler(request)
    }

    throw new SuspendSignal('approval_required', {
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      input: request.toolInput,
    })
  },
})
```

需要直接从结果中读取 checkpoint 时使用 `complete()`，然后为每个 pending tool call 提供一个决策：

```ts
const firstRun = await agent.complete({ state })

if (firstRun.stopReason === 'suspended' && firstRun.checkpoint) {
  const decisions = Object.fromEntries(
    firstRun.checkpoint.runtime.pendingToolCalls.map((call) => [
      call.id,
      { action: 'approve' as const },
    ]),
  )

  for await (const event of agent.resume({
    checkpoint: firstRun.checkpoint,
    decisions,
    props: { approved: true },
  })) {
    if (event.type === 'text_delta') process.stdout.write(event.delta)
  }
}
```

每项决策可以是 `approve`、带可选原因的 `deny`，或通过 `modify` 修改工具输入。`resume()` 会从 checkpoint 重建状态、应用决策、执行剩余工具，并继续 Agent Loop。它不会修改恢复前的原始 `state` 对象；如果调用方需要持久化恢复后的最终状态，应消费 `agent_run_end.state`。

## 消息与持久化

向 `AgentState` 添加历史记录时应使用消息类。User 消息支持文本、URL 或 base64 图片，以及二进制文件。实际多模态支持取决于所选模型和 Provider。

```ts
const message = new UserMessage([
  { type: 'text', text: '描述这张截图。' },
  {
    type: 'image',
    source: { type: 'url', url: 'https://example.com/screenshot.png' },
  },
])

state.messages.push(message)
```

使用导出的序列化函数持久化状态。它们会保留消息元数据，并在反序列化时恢复消息类实例：

```ts
import { deserializeAgentState, serializeAgentState } from '@mech-code/core'

const json = JSON.stringify(serializeAgentState(state))
await storage.set('session-42', json)

const restored = deserializeAgentState(JSON.parse(await storage.get('session-42')))
restored.messages.push(new UserMessage('继续。'))
await agent.complete({ state: restored })
```

`estimateTokens()`、`estimateMessageTokens()` 和 `estimateMessagesTokens()` 可用于快速估算本地 token 预算。这些结果是近似值，不等同于 Provider 的计费数据。

## 公开 API 速查

| 分类     | 主要导出                                                                                                                                                               |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent    | `Agent`、`createAgent`、`createAgentState`、`serializeAgentState`、`deserializeAgentState`、`SuspendSignal`、`isSuspendSignal`                                         |
| Provider | `AnthropicProvider`、`OpenAIProvider`、`OpenAICompatibleProvider`、`ProviderError`、`retryStreamResult`                                                                |
| 工具     | `defineTool`、`registerTool`、`getTool`、`getAllTools`、`getToolDefinitions`、`clearTools`                                                                             |
| 中间件   | `Middleware`、`createMiddleware`、`MiddlewarePipeline`                                                                                                                 |
| 消息     | `SystemMessage`、`UserMessage`、`AssistantMessage`、`ToolMessage`、`MessageAccumulator`、`buildChatParams`                                                             |
| 工具函数 | `estimateTokens`、`estimateMessageTokens`、`estimateMessagesTokens`                                                                                                    |
| 类型     | `AgentState`、`AgentEvent`、`RunParams`、`RunResult`、`LLMProvider`、`ProviderConfig`、`Tool`、`AgentMiddleware`、`RunContext`、`ToolCallDecision` 及相关请求/结果类型 |

## 示例

- [基础 Agent](./examples/basic-agent.ts)：工具、多轮状态和事件渲染。
- [权限中间件](./examples/middleware-auth.ts)：围绕工具调用进行策略检查。
- [Todo 中间件](./examples/middleware-todo.ts)：同时包含状态和工具的自包含中间件。
