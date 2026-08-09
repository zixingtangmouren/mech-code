# Tool Result 与 Context Compact Middleware 设计

> 本文描述当前上下文预算相关的两个独立中间件。工具结果处理和上下文压缩分开实现，避免一个中间件同时承担工具内容投影、清理、摘要和 overflow retry。

## 1. 设计目标

上下文预算分成两层：

- `toolResultMiddleware`：控制工具结果如何进入 Provider 可见上下文。
- `contextCompactMiddleware`：控制 Provider 可见上下文过大时如何压缩和重试。

二者可以独立使用，也可以组合使用。组合时推荐注册顺序：

```ts
middleware: [
  todoMiddleware(),
  toolResultMiddleware(...),
  contextCompactMiddleware(...),
]
```

因为 wrap 链中先注册的中间件在外层，`toolResultMiddleware.wrapModelCall` 会先把本次请求里的 tool message 投影成 preview/cleared 文本，然后 `contextCompactMiddleware.wrapModelCall` 基于已经投影后的 messages 判断是否 compact。

## 2. Tool Result Middleware

`toolResultMiddleware` 只负责工具结果预算、存储、清理和 Provider 可见投影。

Public API：

```ts
toolResultMiddleware(options?: ToolResultMiddlewareOptions): AgentMiddleware

const TOOL_RESULT_STATE_KEY = 'toolResult'
```

配置：

```ts
interface ToolResultMiddlewareOptions {
  maxResultChars?: number
  maxResultTokens?: number
  previewChars?: number
  strategy?: 'preview_only' | 'preview_and_store' | 'truncate'
  storage?: { type: 'state' } | { type: 'file'; dir: string }
  cleanup?: ToolResultCleanupOptions
}

interface ToolResultCleanupOptions {
  maxAgeMs?: number
  replacementText?: string
}
```

状态：

```ts
interface ToolResultState {
  records: Record<string, StoredToolResultRecord>
  cleanup: {
    lastCleanupAt?: number
    clearedToolResultCount?: number
  }
}
```

行为：

- `wrapToolCall` 在工具执行后记录超大结果预算信息，但不修改 `ToolOutput.content`。
- `beforeModel` 扫描已有 tool message，兜底记录 restored state 中尚未登记的超大工具结果。
- `beforeModel` 按 tool message 的 `metadata.createdAt` 和 `cleanup.maxAgeMs` 标记超龄工具结果为 cleared。
- `wrapModelCall` 只改写本次 `request.params.messages`，把超大工具结果投影为 preview，把 cleared 工具结果投影为 replacement text。
- `state.messages` 始终保留原始工具结果，便于审计和 checkpoint。

## 3. Context Compact Middleware

`contextCompactMiddleware` 只负责主动 compact、`context_too_long` 兜底 compact、summary message 和 compressed metadata。

Public API：

```ts
contextCompactMiddleware(options?: ContextCompactMiddlewareOptions): AgentMiddleware

const CONTEXT_COMPACT_STATE_KEY = 'contextCompact'
```

配置：

```ts
interface ContextCompactMiddlewareOptions {
  summaryProvider?: LLMProvider
  modelContextWindow?: number | ((ctx: RunContext) => number)
  tokenCounter?: TokenCounter
  trigger?: ContextTrigger | ContextTrigger[]
  summary?: {
    sources?: SummarySource[]
    sourcePolicy?: 'prefer_fresh_source' | 'always_regenerate'
    prompt?: string
    prefix?: string
    maxTokens?: number
    temperature?: number
  }
  reactiveCompact?: ReactiveCompactOptions
}
```

状态：

```ts
interface ContextCompactState {
  summaries: ContextSummaryRecord[]
}
```

Metadata：

```ts
message.metadata.contextCompact = {
  compressed: true,
  summaryId: string,
}
```

summary message 使用内部 user message：

```ts
metadata: {
  source: 'agent',
  injected: true,
  kind: 'context_summary',
  contextCompact: { summaryId }
}
```

行为：

- 主动 compact 在 `wrapModelCall` 中执行，基于本次 `request.params.messages` 判断 token/messages/fraction trigger。
- compact 输入就是当前 Provider 可见 messages；中间件不关心工具结果投影如何实现。
- 摘要调用不传 tools，并在 prompt 中要求纯文本 `<analysis>` + `<summary>` 输出。
- 写入 state 前剥离 `<analysis>`，只保留格式化后的 summary。
- 被压缩的原始消息保留在 `state.messages`，只写 `metadata.contextCompact.compressed = true`。
- Provider 请求只看到未 compressed 的消息。
- reactive compact 只处理 `ProviderError.code === 'context_too_long'`，默认最多重试 1 次。

事件：

- 开始压缩时发送 `custom(context-compact/started)`，payload 包含 `mode: 'proactive' | 'reactive' | 'manual'`。
- 成功时发送 `custom(context-compact/completed)`，payload 包含 mode、summary id、压缩消息数和压缩前后 token 估算。
- 摘要生成失败时发送 `custom(context-compact/failed)`，payload 包含 mode 和错误文本，并保留原有的“不压缩、继续调用主模型”行为。
- `started` 总是以 `completed` 或 `failed` 收尾；没有触发压缩时不发送事件。

这些事件在摘要请求进行期间由 Agent Loop 实时转发，CLI 因此可以准确显示和结束“正在压缩上下文”状态。完整 summary 记录仍只存放在 `AgentState.contextCompact`。

## 4. CLI 配置

CLI 使用两个顶层配置块：

```json
{
  "toolResult": {
    "maxResultChars": 50000,
    "previewChars": 8000,
    "strategy": "preview_and_store",
    "storage": { "type": "state" },
    "cleanup": {
      "maxAgeMs": 3600000
    }
  },
  "contextCompact": {
    "summaryProvider": "summary",
    "modelContextWindow": 200000,
    "trigger": { "fraction": 0.7 },
    "summary": {
      "maxTokens": 4096,
      "temperature": 0
    },
    "reactiveCompact": {
      "enabled": true,
      "maxRetries": 1
    }
  }
}
```

旧的 `contextManagement` 配置块不再支持。

## 5. 与 Session Notes 的组合

`sessionNotesMiddleware` 可以暴露 `SummarySource`，供 `contextCompactMiddleware` 的 `summary.sources` 使用。`contextCompactMiddleware` 只消费 source，不负责更新 session note。`sourcePolicy` 只有两个真实分支：

- `prefer_fresh_source`：默认值，有 fresh source 时直接复用 source content，不调用 summary provider。
- `always_regenerate`：忽略 source content，始终用当前 Provider 可见消息重新生成 compact summary。

```ts
const sessionNotes = sessionNotesMiddleware({ provider: memoryProvider })

const compact = contextCompactMiddleware({
  summaryProvider,
  summary: {
    sources: [sessionNotes.source],
    sourcePolicy: 'prefer_fresh_source',
  },
})
```

## 6. 验收点

- 超大工具结果不会进入 Provider payload 的完整内容，但 `state.messages` 保留原文。
- cleanup 只影响 Provider 可见投影。
- compact 基于 Provider 可见 messages 生成摘要。
- compact 写入 `metadata.contextCompact`，不读写旧 `metadata.contextManagement`。
- `context_too_long` 会触发 reactive compact 并重试。
- 不保留 `contextManagementMiddleware`、`state.contextManagement` 或旧 CLI 配置兼容代码。
