# Provider 层设计

## 设计目标

Provider 层负责将 Agent Loop 的统一消息格式与各 LLM 厂商的 API 对接。核心职责是**格式适配**与**调用封装**，不包含策略性逻辑（重试、限流、降级等由中间件层处理）。

---

## 分层原则

| 能力                                | 归属                         | 理由                           |
| ----------------------------------- | ---------------------------- | ------------------------------ |
| 消息格式转换（AgentMessage → 厂商） | Provider 内核                | 厂商差异必须封装               |
| 流式 + 非流式 API 调用              | Provider 内核                | 基本通信能力                   |
| stream + final 双通道返回           | Provider 内核                | 调用方人体工学                 |
| 错误类型归一化                      | Provider 内核                | 协议层统一；处理策略交由中间件 |
| 重试机制                            | 中间件                       | 策略可插拔，不应内嵌           |
| 模型参数配置                        | ProviderConfig + CallOptions | 构造时默认 + 单次调用覆盖      |

---

## LLMProvider 接口

```typescript
interface LLMProvider {
  /** Provider 标识符，如 'anthropic' | 'openai' | 'deepseek' */
  readonly name: string

  /** 非流式调用：一次性返回完整响应 */
  chat(params: ChatParams, options?: CallOptions): Promise<ChatResponse>

  /** 流式调用：返回 stream + final 双通道 */
  stream(params: ChatParams, options?: CallOptions): StreamResult
}
```

---

## ChatParams — Provider 输入

```typescript
interface ChatParams {
  messages: AgentMessage[]
  system?: string
  tools?: ToolDefinition[]
}
```

不包含模型参数（temperature 等），这些由 `CallOptions.modelParams` 和 `ProviderConfig.defaultParams` 在调用时注入。
`messages` 保持 Agent 层的 `AgentMessage` 类型；具体厂商 payload 的转换只在 Provider 内部发生。

---

## ChatResponse — 非流式输出

```typescript
interface ChatResponse {
  message: AssistantMessage
  usage: Usage
  stopReason: string
}
```

---

## StreamResult — 流式双通道

```typescript
interface StreamResult {
  /** 事件流：逐 chunk 消费的异步迭代器 */
  stream: AsyncIterable<AgentEvent>

  /**
   * 最终结果 Promise —— 流结束后 resolve。
   * 内部由 MessageAccumulator 累积事件组装完整消息。
   */
  final: Promise<ChatResponse>

  /** 主动中止流 */
  abort(): void
}
```

### 设计考量

- **UI 消费者**只需 `stream`（边流边渲染）
- **Agent Loop** 需要 `final`（拿到完整 assistant message 后才能决定是否继续 turn）
- 两个需求共存，不应让上层重复编写累积逻辑
- Provider 内部跑流：chunk 既 push 到 stream，又喂给 accumulator；流结束时 accumulator resolve final

```typescript
// UI 用法
const { stream } = provider.stream(params)
for await (const event of stream) renderEvent(event)

// Agent Loop 用法
const { stream, final } = provider.stream(params)
for await (const event of stream) emit(event) // 转发事件
const response = await final // 拿最终结果决定下一步
```

---

## CallOptions — 单次调用选项

```typescript
interface CallOptions {
  signal?: AbortSignal
  /** 本次请求的总超时，可覆盖 ProviderConfig.timeoutMs */
  timeoutMs?: number
  /** 本次调用的参数覆盖（不污染 Provider 全局配置） */
  modelParams?: ModelParams
}
```

---

## ModelParams — 模型生成参数

```typescript
interface ModelParams {
  temperature?: number
  maxTokens?: number
  topP?: number
  stopSequences?: string[]
  /** 厂商特定参数逃生口（如 Anthropic 的 thinking、OpenAI 的 response_format） */
  extra?: Record<string, unknown>
}
```

---

## 两层参数配置

```typescript
// 第 1 层：Provider 构造时注入默认参数
const provider = new AnthropicProvider({
  apiKey: '...',
  model: 'claude-sonnet-4-5',
  defaultParams: { temperature: 0.7, maxTokens: 8192 },
})

// 第 2 层：单次调用时覆盖（浅合并 defaultParams）
provider.stream(params, {
  modelParams: { temperature: 0 }, // 仅本次生效
})
```

合并规则：`{ ...config.defaultParams, ...options.modelParams }`

---

## ProviderConfig

```typescript
interface ProviderConfig {
  apiKey: string
  model: string
  baseUrl?: string
  headers?: Record<string, string>
  defaultParams?: ModelParams
  /** 请求总超时（毫秒），默认 300000 */
  timeoutMs?: number
}
```

---

## 错误归一化

### ProviderError

```typescript
class ProviderError extends Error {
  readonly retryable: boolean
  readonly cause?: unknown
  readonly status?: number
  readonly vendorCode?: string
  readonly requestId?: string
  readonly retryAfterMs?: number

  constructor(
    public readonly code: ProviderErrorCode,
    public readonly provider: string,
    message: string,
    options?: ProviderErrorOptions,
  )
}
```

### ProviderErrorCode

```typescript
type ProviderErrorCode =
  | 'auth_failed'
  | 'permission_denied'
  | 'billing_error'
  | 'quota_exceeded'
  | 'rate_limited'
  | 'context_too_long'
  | 'model_not_found'
  | 'not_found'
  | 'request_too_large'
  | 'conflict'
  | 'timeout'
  | 'overloaded'
  | 'server_error'
  | 'network_error'
  | 'invalid_response'
  | 'invalid_request'
  | 'aborted'
  | 'unknown'
```

### 错误翻译规则

Provider 先解析厂商 JSON 错误结构，再使用 HTTP 状态码兜底。不能只根据状态码决定是否重试，例如 OpenAI 的 429 同时表示临时限流和余额/配额耗尽。

| HTTP 状态 / 厂商错误                      | ProviderErrorCode   | retryable |
| ----------------------------------------- | ------------------- | --------- |
| 401                                       | `auth_failed`       | ❌        |
| 403                                       | `permission_denied` | ❌        |
| Anthropic 402 / `billing_error`           | `billing_error`     | ❌        |
| OpenAI `insufficient_quota`               | `quota_exceeded`    | ❌        |
| 临时 429 / `rate_limit_error`             | `rate_limited`      | ✅        |
| 明确的上下文窗口超限                      | `context_too_long`  | ❌        |
| 404 + 明确的 model not found              | `model_not_found`   | ❌        |
| 413                                       | `request_too_large` | ❌        |
| 408 / 504                                 | `timeout`           | ✅        |
| Anthropic 529 / `overloaded_error`        | `overloaded`        | ✅        |
| 5xx                                       | `server_error`      | ✅        |
| 建连失败或响应体中途断开                  | `network_error`     | ✅        |
| JSON 损坏、结构不合法、流缺少终止事件     | `invalid_response`  | ❌        |
| 用户 AbortSignal / `StreamResult.abort()` | `aborted`           | ❌        |

`status`、`vendorCode` 和 `requestId` 用于诊断；`retryAfterMs` 保存厂商 `Retry-After` 指示。中间件读取 `retryable` 决定是否重试，并应优先遵循 `retryAfterMs`，否则使用带 jitter 的指数退避。

### 流内错误

HTTP 200 不代表流一定成功。Provider 在 normalizer 之前校验厂商事件：

- Anthropic `type: "error"`、OpenAI `type: "error"` 和 `response.failed` 直接抛出 `ProviderError`
- OpenAI `response.incomplete` 保留已经生成的内容，并将原因与 usage 写入最终响应
- Anthropic 必须收到 `message_stop`；OpenAI Chat 必须收到非空 `finish_reason`；OpenAI Responses 必须收到 `response.completed` 或 `response.incomplete`
- SSE JSON 损坏、已知事件结构错误或流提前结束统一归类为 `invalid_response`

---

## Provider 内部三组件拆分

每个 Provider 实现拆为 3 个职责清晰的模块：

```
AnthropicProvider
├── serializer.ts        ← AgentMessage[] → Anthropic API 请求体
├── normalizer.ts        ← Anthropic SSE chunk → AgentEvent[]
└── provider.ts          ← 组装调用：serialize → fetch → normalize
```

### MessageSerializer

```typescript
interface MessageSerializer<TVendorRequest = unknown> {
  serialize(messages: AgentMessage[], options: SerializeOptions): TVendorRequest
}

interface SerializeOptions {
  system?: string
  tools?: ToolDefinition[]
  modelParams?: ModelParams
}
```

将规范的 `AgentMessage` 直接转换为厂商 API 要求的请求格式。消息构造器已经保证 user/assistant content 为内容块数组，serializer 只处理厂商字段和能力差异，不再建立通用中间消息类型。

### StreamNormalizer

```typescript
interface StreamNormalizer<TVendorChunk = unknown> {
  /** 处理一个厂商原始 chunk，返回零或多个 AgentEvent */
  push(chunk: TVendorChunk): AgentEvent[]
  /** 流结束时刷出缓冲中的剩余事件 */
  flush(): AgentEvent[]
  /** 返回流结束后的 usage 与 stopReason */
  getStreamMeta(): StreamMeta
}
```

有状态的推模型适配器，将厂商特定的流式 chunk 格式翻译为统一的 AgentEvent 序列。

---

## BaseProvider 抽象类

提供各 Provider 实现的共性逻辑，避免重复代码：

```typescript
abstract class BaseProvider implements LLMProvider {
  abstract readonly name: string

  constructor(protected readonly config: ProviderConfig) {}

  abstract chat(params: ChatParams, options?: CallOptions): Promise<ChatResponse>
  abstract stream(params: ChatParams, options?: CallOptions): StreamResult

  protected mergeParams(override?: ModelParams): ModelParams
  protected parseHttpError(response: Response): Promise<ProviderError>
  protected classifyHttpError(context: HttpErrorContext): ProviderErrorDescriptor
  protected parseJsonResponse(response: Response, signal?: AbortSignal): Promise<unknown>
  protected createRequestSignal(...): { signal: AbortSignal; cleanup(): void }
  protected buildStreamResult(...): StreamResult
}
```

---

## 文件布局

```
packages/core/src/provider/
├── types.ts                 # LLMProvider / ChatParams / StreamResult / CallOptions / ModelParams
├── errors.ts                # ProviderError + ProviderErrorCode
├── base.ts                  # BaseProvider 抽象类
├── stream-result.ts         # createStreamResult() — 组装 stream + final + abort
├── anthropic/
│   ├── provider.ts          # AnthropicProvider extends BaseProvider
│   ├── serializer.ts        # AnthropicSerializer implements MessageSerializer
│   └── normalizer.ts        # AnthropicStreamNormalizer implements StreamNormalizer
├── openai/
│   ├── provider.ts          # OpenAIProvider extends BaseProvider
│   ├── serializer.ts        # OpenAISerializer
│   └── normalizer.ts        # OpenAIStreamNormalizer
└── openai-compatible/
    └── provider.ts          # OpenAICompatibleProvider extends OpenAIProvider（只覆盖 baseUrl）
```

---

## 重试为何不放 Provider

重试是**策略**，不是**能力**：

- 同一个 Provider，不同 Agent 可能用不同重试策略（开发不重试、生产指数退避、CI 快速失败）
- 重试逻辑与所有 Provider 无关，一份中间件通用
- Provider 保留 `Retry-After`，但由中间件决定实际等待与最大重试次数
- 重试期间可触发事件（如 `retry_attempt`）让 UI 展示"正在重试..."
- 测试时需要禁用重试，中间件方案只需不注册

```typescript
// Provider 只标记 retryable，中间件实现策略
const agent = createAgent({
  provider,
  middleware: [retryMiddleware({ maxRetries: 3, backoff: 'exponential' })],
})
```

---

## 与 Agent Loop 的集成点

```
Agent Loop
    │
    ├── 构建 ChatParams（messages + system + tools）
    │
    ├── provider.stream(params, { signal })
    │        │
    │        ├── stream → 逐事件 emit（UI 消费）
    │        └── final  → 得到 ChatResponse
    │
    ├── 判断 stopReason
    │    ├── 'end_turn' → 结束
    │    ├── 'tool_use' → 执行工具 → 组装 tool message → 继续 turn
    │    └── 'max_tokens' → 视策略决定是否续写
    │
    └── 中间件 hook 介入点
         ├── beforeLLMCall  → 拦截/修改 params
         ├── afterLLMResponse → 拦截/修改 response
         └── onError → 重试中间件在此介入
```
