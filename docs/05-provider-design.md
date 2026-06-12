# Provider 层设计

## 设计目标

Provider 层负责将 Agent Loop 的统一消息格式与各 LLM 厂商的 API 对接。核心职责是**格式适配**与**调用封装**，不包含策略性逻辑（重试、限流、降级等由中间件层处理）。

---

## 分层原则

| 能力                        | 归属                         | 理由                           |
| --------------------------- | ---------------------------- | ------------------------------ |
| 消息格式转换（内部 ↔ 厂商） | Provider 内核                | 厂商差异必须封装               |
| 流式 + 非流式 API 调用      | Provider 内核                | 基本通信能力                   |
| stream + final 双通道返回   | Provider 内核                | 调用方人体工学                 |
| 错误类型归一化              | Provider 内核                | 协议层统一；处理策略交由中间件 |
| 重试机制                    | 中间件                       | 策略可插拔，不应内嵌           |
| 模型参数配置                | ProviderConfig + CallOptions | 构造时默认 + 单次调用覆盖      |

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
  content: AssistantContentBlock[]
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
}
```

---

## 错误归一化

### ProviderError

```typescript
class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    public readonly provider: string,
    message: string,
    public readonly cause?: unknown,
    public readonly retryable: boolean = false,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}
```

### ProviderErrorCode

```typescript
type ProviderErrorCode =
  | 'auth_failed' // 401/403
  | 'rate_limited' // 429（retryable）
  | 'context_too_long' // 上下文超限
  | 'model_not_found' // 模型不存在
  | 'server_error' // 5xx（retryable）
  | 'network_error' // 网络层异常（retryable）
  | 'invalid_request' // 4xx 参数错误
  | 'aborted' // 用户主动中止
  | 'unknown' // 未分类错误
```

### 错误翻译规则

Provider 负责将厂商响应翻译为统一 `ProviderError`：

| HTTP 状态 / 错误       | ProviderErrorCode  | retryable |
| ---------------------- | ------------------ | --------- |
| 401 / 403              | `auth_failed`      | ❌        |
| 429                    | `rate_limited`     | ✅        |
| 400 + "context length" | `context_too_long` | ❌        |
| 404 + model 相关       | `model_not_found`  | ❌        |
| 5xx                    | `server_error`     | ✅        |
| 网络超时 / DNS 失败    | `network_error`    | ✅        |
| AbortError             | `aborted`          | ❌        |
| 其他 4xx               | `invalid_request`  | ❌        |

中间件读取 `retryable` 字段决策，不关心具体厂商。

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

将 AgentMessage 转换为厂商 API 要求的请求格式。serializer 内部可以先投影为 provider 规范化中间形态，但这个中间形态不暴露给 Agent Loop 和 middleware。

### StreamNormalizer

```typescript
interface StreamNormalizer<TVendorChunk = unknown> {
  /** 处理一个厂商原始 chunk，返回零或多个 AgentEvent */
  push(chunk: TVendorChunk): AgentEvent[]
  /** 流结束时刷出缓冲中的剩余事件 */
  flush(): AgentEvent[]
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

  /** 子类实现：发送非流式请求 */
  protected abstract doChat(params: ChatParams, merged: ModelParams): Promise<ChatResponse>

  /** 子类实现：发送流式请求，返回厂商原始 chunk 流 */
  protected abstract doStream(
    params: ChatParams,
    merged: ModelParams,
    signal: AbortSignal,
  ): AsyncIterable<unknown>

  /** 子类实现：创建对应的 StreamNormalizer */
  protected abstract createNormalizer(): StreamNormalizer

  // --- 公共实现 ---

  chat(params: ChatParams, options?: CallOptions): Promise<ChatResponse> {
    const merged = this.mergeParams(options?.modelParams)
    return this.doChat(params, merged)
  }

  stream(params: ChatParams, options?: CallOptions): StreamResult {
    // 1. 合并参数
    // 2. 创建 abort controller
    // 3. 启动流 + normalizer + accumulator
    // 4. 返回 { stream, final, abort }
  }

  /** 合并 defaultParams 与 callOptions */
  private mergeParams(override?: ModelParams): ModelParams { ... }
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
