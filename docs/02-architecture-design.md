# mech-code 代码架构设计文档

> 版本：v0.2.0 · 日期：2026-05-30

---

## 1. 整体架构：SDK-First

核心设计理念：**SDK 承载所有能力，CLI 是 SDK 的消费者**。

```
┌──────────────────────────────────────────────────────────┐
│  mech-code (pnpm monorepo)                               │
│                                                          │
│  packages/                                               │
│  ├── @mech-code/shared      ← 共享协议类型 / 工具函数     │
│  ├── @mech-code/core        ← Agent 核心框架              │
│  ├── @mech-code/tools       ← 内置工具实现                │
│  ├── @mech-code/middleware  ← 内置中间件实现              │
│  └── @mech-code/cli         ← 终端产物（组装其他包）       │
└──────────────────────────────────────────────────────────┘
```

- **`@mech-code/shared`**：跨包复用的协议类型与纯工具函数
- **`@mech-code/core`**：Agent、Provider、消息、Tool 和 Middleware 等核心协议与运行时
- **`@mech-code/tools`**：基于 core Tool 协议实现的文件与 Shell 工具
- **`@mech-code/middleware`**：基于 core Middleware 协议实现的上下文、工具结果与 Todo 中间件
- **`@mech-code/cli`**：终端 UI（Ink）、配置加载及各运行时包的装配入口

---

## 2. 多模型 Provider 支持

### 2.1 Provider 接口

```ts
interface LLMProvider {
  chat(params: ChatParams): Promise<ChatResponse>
  stream(params: ChatParams): AsyncIterable<StreamEvent>
}

interface ProviderConfig {
  baseUrl?: string
  model: string
  apiKey: string
  headers?: Record<string, string>
}
```

### 2.2 内置 Provider

| Provider                   | 说明                                              |
| -------------------------- | ------------------------------------------------- |
| `AnthropicProvider`        | Anthropic 原生 API                                |
| `OpenAIProvider`           | OpenAI 原生 API                                   |
| `OpenAICompatibleProvider` | 通用兼容协议（覆盖 DeepSeek、Ollama 等 90% 厂商） |

### 2.3 配置文件（JSON）

**全局** `~/.mech/config.json`：

```json
{
  "default": "anthropic",
  "providers": {
    "anthropic": {
      "baseUrl": "https://api.anthropic.com",
      "model": "claude-sonnet-4-20250514",
      "apiKeyEnv": "ANTHROPIC_API_KEY"
    },
    "deepseek": {
      "baseUrl": "https://api.deepseek.com/v1",
      "model": "deepseek-chat",
      "apiKey": "sk-xxx"
    },
    "local": {
      "baseUrl": "http://localhost:11434/v1",
      "model": "llama3",
      "apiKey": "none"
    }
  }
}
```

**项目级** `.mech.json`（覆盖全局）：

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "system": "You are a code assistant for this project.",
  "mcp": {
    "servers": {
      "filesystem": { "command": "npx", "args": ["-y", "@mcp/filesystem"] }
    }
  },
  "skills": ["code-review"]
}
```

优先级：**CLI 参数 > `.mech.json` > `~/.mech/config.json` > 环境变量**

---

## 3. SDK 对外 API

### 3.1 AgentMessage（支持多模态）

```ts
type UserContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: ImageSource }
  | { type: 'file'; data: Uint8Array; mediaType: string }

type AssistantContentBlock =
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

type ImageSource =
  | { type: 'base64'; mediaType: string; data: string }
  | { type: 'url'; url: string }

type AgentMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage
```

`UserMessage` 和 `AssistantMessage` 构造器接受字符串简写，但创建后的 `content` 始终是对应的内容块数组。Agent Loop、middleware 和 Provider 都使用这一种规范形态。

### 3.2 调用方式

```ts
import { UserMessage, createAgent, createAgentState } from '@mech-code/core'

const agent = createAgent({
  provider: { baseUrl: '...', model: '...', apiKey: '...' },
  tools: [...],
  system: '...',
  middleware: [...],
})

const state = createAgentState()
state.messages.push(
  new UserMessage([
    { type: 'text', text: '帮我分析这张图片' },
    { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: '...' } },
  ]),
)

const events = agent.run({ state, config: { maxTurns: 10 } })

for await (const event of events) {
  // 处理事件
}

state.messages.push(new UserMessage('继续分析'))
const result = await agent.complete({ state })
// result.text / result.usage / result.stopReason
```

---

## 4. 事件系统（多阶段 × 三态）

### 4.1 设计规则

每个阶段遵循统一模式：`{phase}_start` → `{phase}_content` / `{phase}_delta` → `{phase}_end`

### 4.2 事件流程

```
agent_run_start
│
├── reasoning_start
│   ├── reasoning_content  (×N，thinking 流式输出)
│   └── reasoning_end
│
├── text_start
│   ├── text_delta         (×N，文本流式输出)
│   └── text_end
│
├── tool_start
│   ├── tool_input_delta   (×N，入参流式拼接)
│   ├── tool_executing     (开始执行)
│   ├── tool_result        (执行完毕)
│   └── tool_end
│
├── mcp_start
│   ├── mcp_executing
│   ├── mcp_result
│   └── mcp_end
│
├── custom                  (中间件定义的可序列化事件)
│
├── turn_end               (单轮结束，可能有下一轮)
├── turn_start             (新一轮开始)
│
└── agent_run_end
```

### 4.3 完整类型定义

```ts
// === Agent 级 ===
type AgentRunStartEvent = {
  type: 'agent_run_start'
  runId: string
  messages: Message[]
}
type AgentRunEndEvent = {
  type: 'agent_run_end'
  runId: string
  usage: Usage
  messages: Message[]
  state: SerializableAgentState
  stopReason: 'end_turn' | 'max_turns' | 'error' | 'abort' | 'suspended'
}

type CustomAgentEvent<TPayload = JsonValue> = {
  type: 'custom'
  runId: string
  turnIndex: number
  source: string
  name: string
  payload: TPayload
}

// === Reasoning ===
type ReasoningStartEvent = { type: 'reasoning_start' }
type ReasoningContentEvent = { type: 'reasoning_content'; text: string }
type ReasoningEndEvent = { type: 'reasoning_end'; fullText: string }

// === Text ===
type TextStartEvent = { type: 'text_start' }
type TextDeltaEvent = { type: 'text_delta'; delta: string }
type TextEndEvent = { type: 'text_end'; fullText: string }

// === Tool ===
type ToolStartEvent = {
  type: 'tool_start'
  toolCallId: string
  toolName: string
}
type ToolInputDeltaEvent = {
  type: 'tool_input_delta'
  toolCallId: string
  delta: string
}
type ToolExecutingEvent = {
  type: 'tool_executing'
  toolCallId: string
  toolName: string
  input: unknown
}
type ToolResultEvent = {
  type: 'tool_result'
  toolCallId: string
  toolName: string
  output: unknown
  isError: boolean
}
type ToolEndEvent = {
  type: 'tool_end'
  toolCallId: string
}

// === MCP ===
type MCPStartEvent = { type: 'mcp_start'; server: string; method: string }
type MCPExecutingEvent = { type: 'mcp_executing'; server: string; method: string; params: unknown }
type MCPResultEvent = {
  type: 'mcp_result'
  server: string
  method: string
  result: unknown
  isError: boolean
}
type MCPEndEvent = { type: 'mcp_end'; server: string }

// === Turn ===
type TurnStartEvent = { type: 'turn_start'; turnIndex: number }
type TurnEndEvent = { type: 'turn_end'; turnIndex: number; usage: Usage }

// === Union ===
type AgentEvent =
  | AgentRunStartEvent
  | AgentRunEndEvent
  | ReasoningStartEvent
  | ReasoningContentEvent
  | ReasoningEndEvent
  | TextStartEvent
  | TextDeltaEvent
  | TextEndEvent
  | ToolStartEvent
  | ToolInputDeltaEvent
  | ToolExecutingEvent
  | ToolResultEvent
  | ToolEndEvent
  | MCPStartEvent
  | MCPExecutingEvent
  | MCPResultEvent
  | MCPEndEvent
  | TurnStartEvent
  | TurnEndEvent
```

### 4.4 消费示例

```ts
for await (const event of agent.run({ messages })) {
  switch (event.type) {
    case 'reasoning_content':
      renderThinking(event.text)
      break
    case 'text_delta':
      process.stdout.write(event.delta)
      break
    case 'tool_executing':
      showToolCallUI(event.toolName, event.input)
      break
    case 'tool_result':
      showToolResult(event.toolName, event.output)
      break
    case 'agent_run_end':
      showUsage(event.usage)
      break
  }
}
```

---

## 5. Core 内部分层

### 5.1 分层模型

```
┌──────────────────────────────────────────────────────┐
│  Public API (createAgent, Agent.run, Agent.complete)  │  ← 对外接口
├──────────────────────────────────────────────────────┤
│  Agent Loop Engine（基础设施，不可替换）                │  ← 循环编排
├──────────────────────────────────────────────────────┤
│  Middleware Pipeline（策略层，可插拔）                  │  ← 用户扩展点
├──────────────────────────────────────────────────────┤
│  Protocol Layer（协议接口，不可替换）                  │  ← Provider/Tool/Message
└──────────────────────────────────────────────────────┘
```

### 5.2 基础设施（不可替换）

| 模块            | 职责                                                |
| --------------- | --------------------------------------------------- |
| Loop Engine     | 循环编排（call LLM → parse → dispatch tool → loop） |
| Event Emitter   | 事件产出管线，保证顺序和完整性                      |
| Message Builder | 组装 messages + system + tool_results 为 API 请求   |
| Turn Controller | 计数、maxTurns 限制、stop_reason 判定               |
| Abort Handler   | AbortSignal 传播、优雅中断                          |
| Error Boundary  | 错误捕获、重试、降级                                |

### 5.3 Middleware 策略层（可插拔）

#### Middleware 接口

```ts
interface AgentMiddleware {
  name: string

  // === 请求阶段 ===
  /** LLM 调用前：修改 messages、注入上下文、裁剪历史 */
  beforeLLMCall?(ctx: MiddlewareContext): Promise<void> | void

  /** LLM 调用后、tool 执行前：拦截/修改 tool 调用决策 */
  afterLLMResponse?(ctx: MiddlewareContext): Promise<void> | void

  // === 工具阶段 ===
  /** 工具执行前：校验入参、权限检查、限流 */
  beforeToolExec?(ctx: ToolExecContext): Promise<void> | void

  /** 工具执行后：截断结果、格式化、脱敏 */
  afterToolExec?(ctx: ToolExecContext): Promise<void> | void

  // === 生命周期 ===
  onRunStart?(ctx: MiddlewareContext): Promise<void> | void
  onTurnEnd?(ctx: MiddlewareContext): Promise<void> | void
  onRunEnd?(ctx: MiddlewareContext): Promise<void> | void
}
```

#### Middleware Context

```ts
interface MiddlewareContext {
  // 可读写
  messages: Message[]
  system: string
  tools: ToolDefinition[]
  store: Record<string, unknown>

  // 只读
  readonly turnIndex: number
  readonly usage: Usage
  readonly provider: ProviderConfig
  readonly signal: AbortSignal
}

interface ToolExecContext extends MiddlewareContext {
  toolName: string
  toolInput: unknown
  toolResult?: unknown
  skipExecution?: boolean
  overrideResult?: unknown
}
```

### 5.4 内置 Middleware（我们实现，用户按需启用）

#### Context Window Manager（上下文管理）

```ts
createContextManager({
  strategy: 'sliding-window', // | 'summarize' | 'truncate-oldest' | 'custom'
  maxTokens: 180_000,
  reserveForOutput: 8_000,
})
```

- `sliding-window`：丢弃最早 N 条消息
- `summarize`：调用 LLM 压缩早期对话为摘要
- `truncate-oldest`：直接截断
- `custom`：用户传入 `(messages, budget) => messages`

#### Tool Constraints（工具约束）

```ts
createToolConstraints({
  rules: {
    read_file: {
      maxFileSize: '1MB',
      allowedExtensions: ['.ts', '.js', '.json', '.md', '.py'],
      binaryBehavior: 'reject',
    },
    shell: {
      allowList: ['ls', 'cat', 'grep', 'find'],
      denyList: ['rm', 'sudo'],
      timeout: 30_000,
    },
    '*': { timeout: 60_000, maxRetries: 2 },
  },
  onViolation: 'return-error',
})
```

#### Result Processor（结果截断）

```ts
createResultProcessor({
  maxResultTokens: 10_000,
  truncation: 'head-tail',
  oversizeMessage: '[Truncated: {original} → {truncated} tokens]',
})
```

#### Attachment Injector（动态上下文注入）

```ts
createAttachmentInjector({
  providers: [
    {
      name: 'relevant-files',
      resolve: async (ctx) => {
        const lastMsg = getLastUserMessage(ctx.messages)
        const files = await searchCodebase(lastMsg)
        return files.map((f) => ({ type: 'text', text: `[${f.path}]\n${f.content}` }))
      },
      position: 'system-append',
      maxTokens: 20_000,
    },
  ],
})
```

#### Permission Guard（权限审批）

```ts
createPermissionGuard({
  mode: 'auto',
  autoApprove: ['read_file', 'search', 'list_dir'],
  requireApproval: ['write_file', 'shell', 'delete_file'],
  onApprovalNeeded: async (toolName, input) => await askUser(`Allow ${toolName}?`),
})
```

### 5.5 用户组装示例

```ts
const agent = createAgent({
  provider: { ... },
  tools: [ ... ],
  system: '...',
  middleware: [
    createContextManager({ strategy: 'sliding-window', maxTokens: 180_000 }),
    createToolConstraints({ rules: { ... } }),
    createResultProcessor({ maxResultTokens: 10_000 }),
    createAttachmentInjector({ providers: [ ... ] }),
    createPermissionGuard({ mode: 'auto', ... }),
    // 用户自定义
    { name: 'my-logger', afterToolExec(ctx) { log(ctx.toolResult) } },
  ],
})
```

---

## 6. Agent Loop 执行流程

```
agent.run(params)
│
├─ emit: agent_run_start
├─ middleware[*].onRunStart
│
├─ [LOOP] while (shouldContinue)
│   │
│   │  ┌─── beforeLLMCall (middleware 顺序执行) ────────┐
│   │  │ contextManager: 裁剪到 token budget             │
│   │  │ attachmentInjector: 注入动态上下文              │
│   │  │ userMiddleware: 自定义前置逻辑                  │
│   │  └────────────────────────────────────────────────┘
│   │
│   ├─ call LLM (stream)
│   │   ├─ thinking block → emit reasoning_start/content/end
│   │   ├─ text block     → emit text_start/delta/end
│   │   └─ tool_use block → emit tool_start/input_delta
│   │
│   │  ┌─── afterLLMResponse (middleware 顺序执行) ─────┐
│   │  │ 可拦截/修改 tool_use 决策                       │
│   │  └────────────────────────────────────────────────┘
│   │
│   ├─ if tool_use:
│   │   │
│   │   │  ┌─── beforeToolExec ─────────────────────────┐
│   │   │  │ toolConstraints: 校验入参/大小/权限          │
│   │   │  │ permissionGuard: 审批                       │
│   │   │  └────────────────────────────────────────────┘
│   │   │
│   │   ├─ emit tool_executing
│   │   ├─ execute tool (or MCP call)
│   │   ├─ emit tool_result
│   │   │
│   │   │  ┌─── afterToolExec ──────────────────────────┐
│   │   │  │ resultProcessor: 截断过长结果               │
│   │   │  └────────────────────────────────────────────┘
│   │   │
│   │   ├─ emit tool_end
│   │   └─ append tool_result to messages → continue loop
│   │
│   ├─ emit turn_end
│   ├─ middleware[*].onTurnEnd
│   └─ if stop_reason == end_turn → break
│
├─ middleware[*].onRunEnd
└─ emit: agent_run_end
```

---

## 7. MCP 集成

```ts
interface MCPConfig {
  servers: Record<string, MCPServerDef>
}

interface MCPServerDef {
  command: string
  args?: string[]
  env?: Record<string, string>
}
```

- Agent 启动时 spawn MCP server 子进程（stdio JSON-RPC）
- 自动将 MCP server 暴露的 tools 注册到 ToolRegistry
- Agent Loop 中若 tool_use match 到 MCP tool，走 MCP 调用通道
- 事件流中通过 `mcp_start` / `mcp_executing` / `mcp_result` / `mcp_end` 上报

---

## 8. SKILL 抽象

```ts
interface Skill {
  name: string
  description: string
  systemPrompt?: string
  tools?: Tool[]
  middleware?: AgentMiddleware[]
  beforeRun?: (ctx: MiddlewareContext) => void
  afterRun?: (ctx: MiddlewareContext, result: RunResult) => void
}
```

Skill = **预定义 system prompt + tools 组合 + 可选 middleware + 执行策略钩子**

---

## 9. @mech-code/core 目录结构

```
packages/core/src/
├── agent/
│   ├── agent.ts                # Agent 对外接口
│   ├── hitl.ts                 # 中断恢复与 checkpoint
│   ├── loop.ts                 # Agent Loop
│   ├── state.ts                # Agent 状态变更
│   └── types.ts                # Agent 运行参数与结果类型
├── events/
│   └── emitter.ts              # AgentEvent 异步事件流
├── mcp/
│   ├── client.ts               # MCP stdio 客户端
│   └── types.ts                # MCP 协议类型
├── message/
│   ├── accumulator.ts          # 流式响应累积
│   ├── builder.ts              # 消息构建
│   ├── message.ts              # 消息类、构造规范化与序列化
│   └── tokenizer.ts            # token 估算
├── middleware/
│   ├── pipeline.ts             # 中间件管道与 wrap 链
│   └── types.ts                # AgentMiddleware 接口
├── provider/
│   ├── anthropic/              # Anthropic Provider 与协议转换
│   ├── openai/                 # OpenAI Chat/Responses Provider
│   ├── openai-compatible/      # OpenAI 兼容 Provider
│   ├── base.ts                 # Provider 基类
│   ├── errors.ts               # Provider 错误
│   ├── stream-result.ts        # 流式结果封装
│   └── types.ts                # Provider 接口
├── skills/
│   ├── registry.ts             # Skill 注册表
│   └── types.ts                # Skill 类型
├── tools/
│   ├── types.ts                # Tool 接口
│   ├── registry.ts             # 注册中心
│   └── define.ts               # defineTool 辅助函数
└── index.ts                    # 公开导出
```

`__tests__/` 与相应模块同级放置，未在目录树中重复展开。

---

## 10. @mech-code/cli 目录结构

```
packages/cli/src/
├── index.ts                    # CLI 入口
├── commands/                   # commander 子命令
│   ├── chat.ts
│   └── index.ts
├── config/                     # 配置文件加载/合并
│   ├── loader.ts
│   ├── schema.ts
│   └── middleware.ts           # CLI 中间件装配
├── prompts/
│   └── system.ts               # 默认系统提示词
├── ui/                         # ink 终端 UI
│   ├── App.tsx
│   ├── commands.ts             # UI 命令解析
│   ├── theme.ts                # 终端主题
│   ├── hooks/
│   │   └── useEventAggregator.ts
│   └── components/             # 会话、输入、状态与消息组件
└── adapters/                   # core 事件 → UI 渲染适配
    └── event-renderer.ts
```

---

## 11. @mech-code/tools 目录结构

```
packages/tools/src/
├── bash/
│   ├── classifier.ts           # 命令风险分类
│   ├── executor.ts             # Shell 命令执行
│   ├── output.ts               # 输出截断与整理
│   ├── semantics.ts            # 命令语义分析
│   └── index.ts                # bash 工具定义
├── read-file.ts                # 文件读取工具
├── write-file.ts               # 文件写入工具
├── edit-file.ts                # 文件编辑工具
└── index.ts                    # 内置工具统一导出
```

---

## 12. @mech-code/middleware 目录结构

```
packages/middleware/src/
├── context-compact/            # 上下文压缩、触发器与摘要
├── tool-result/                # 工具结果存储、投影、清理与可见性
├── todo.ts                     # Todo 状态中间件
└── index.ts                    # 内置中间件统一导出
```

---

## 13. @mech-code/shared 目录结构

```
packages/shared/src/
├── path.ts                     # 路径辅助函数
├── string.ts                   # 字符串辅助函数
└── index.ts                    # 共享协议类型与统一导出
```

---

## 14. 设计原则总结

| 原则                | 说明                                                        |
| ------------------- | ----------------------------------------------------------- |
| SDK-First           | 所有能力在 core 实现，CLI 只是薄壳消费者                    |
| 事件驱动            | Agent Loop 产出 `AsyncIterable<AgentEvent>`，消费方自由处理 |
| Provider 可插拔     | 统一接口 + 自定义 baseUrl 可接入任意兼容模型                |
| Middleware 洋葱模型 | 所有策略决策（裁剪/约束/注入/审批）通过 middleware 实现     |
| 配置分层            | CLI 参数 > 项目级 > 全局 > 环境变量                         |
| Messages 用户可控   | SDK 接收完整 messages 数组，多模态、上下文由用户构建        |
| MCP 原生            | 内置 MCP client，自动发现工具，事件流可观测                 |
| 零 Node 耦合        | core 不依赖 Node 特有 API，CLI 单独打包                     |
