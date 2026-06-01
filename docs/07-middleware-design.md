# Middleware 中间件设计文档

> 版本：v0.2.0 · 日期：2026-05-31

---

## 1. 设计目标

中间件是 Agent Loop 的策略扩展机制，用于将横切关注点（上下文压缩、权限控制、重试、限流、可观测性等）从核心循环中解耦。设计上需要满足：

- **职责分明**：Hook 只做状态读写，Wrap 只做行为包裹，不混合
- **接口精简**：最少的 Hook/Wrap 覆盖最常见的扩展场景
- **可组合**：多个中间件按注册顺序组合，互不干扰
- **Loop 保持控制权**：中间件通过 Context 影响状态，不直接操控控制流

---

## 2. 核心概念：Hook + Wrap 双模式

### 2.1 Hook（状态观察与修改）

Hook 在 Agent Loop 的特定时机被顺序调用，职责是**读取或修改 Context 中的状态字段**。

- Hook 不应控制执行流程（不要在 Hook 里决定"是否执行"）
- Hook 的修改对后续流程可见（如 `beforeModel` 修改 `ctx.callMessages`，模型调用时会使用修改后的值）

### 2.2 Wrap（行为包裹）

Wrap 以洋葱模型包裹核心操作（模型调用、工具执行），通过 `next()` 调用内层逻辑。

- 在 `next()` 前后可添加任意处理逻辑（重试、缓存、超时、权限拦截等）
- 不调用 `next()` 即可拦截执行并返回替代结果
- 最先注册的中间件在最外层（先执行）

---

## 3. 中间件接口

中间件设计为 **class 形式**，创建 Agent 时同时创建中间件实例。中间件通过实例属性管理私有状态，通过保留字段 `state` 声明需要共享的公有状态。

```ts
/** 中间件基类 */
abstract class AgentMiddleware {
  abstract name: string

  /**
   * 公有状态（保留字段）。
   * 声明在此的数据会自动同步到 AgentState.middlewareStates[name] 中，
   * 其他中间件可通过 AgentState 读取。支持序列化持久化。
   */
  state: Record<string, unknown> = {}

  // === Hook 式：状态观察与修改 ===

  /** Agent run 开始时触发，可做初始化工作（加载配置、初始化计数器等） */
  beforeAgent?(ctx: RunContext): Awaitable<void>

  /** Agent run 结束后触发（类似 finally，即使出错也执行），用于清理和收尾 */
  afterAgent?(ctx: RunContext): Awaitable<void>

  /** 模型调用前：可修改 callMessages / system / tools（上下文压缩、动态注入等） */
  beforeModel?(ctx: RunContext): Awaitable<void>

  /** 模型响应后、工具执行前：可观察模型输出、更新 state 中的统计或元信息 */
  afterModel?(ctx: RunContext): Awaitable<void>

  // === Wrap 式：包裹核心操作 ===

  /** 包裹模型调用。调用 next(ctx) 执行实际请求，可在外部添加重试/缓存/限流逻辑 */
  wrapModelCall?(next: ModelCallFn, ctx: RunContext): Awaitable<StreamResult>

  /** 包裹工具执行。调用 next(ctx) 执行实际工具，可在外部添加权限/超时/熔断逻辑 */
  wrapToolCall?(next: ToolCallFn, ctx: ToolCallContext): Awaitable<ToolOutput>
}
```

对于无状态的简单中间件，也支持对象字面量形式（不需要 `state` 字段）：

```ts
const logger: AgentMiddleware = {
  name: 'logger',
  afterModel(ctx) {
    console.log(ctx.lastResponse)
  },
}
```

### 对比旧设计（已废弃）

| 旧接口             | 新接口          | 变更说明                               |
| ------------------ | --------------- | -------------------------------------- |
| `onRunStart`       | `beforeAgent`   | 重命名，语义更清晰                     |
| `onRunEnd`         | `afterAgent`    | 重命名                                 |
| `beforeLLMCall`    | `beforeModel`   | 重命名                                 |
| `afterLLMResponse` | `afterModel`    | 重命名                                 |
| `onTurnEnd`        | —               | 移除，需要的场景在 `afterModel` 中处理 |
| `beforeToolExec`   | —               | 移除，职责由 `wrapToolCall` 承担       |
| `afterToolExec`    | —               | 移除，职责由 `wrapToolCall` 承担       |
| `wrapLLMCall`      | `wrapModelCall` | 重命名                                 |
| `wrapToolExec`     | `wrapToolCall`  | 重命名                                 |
| `skipExecution`    | —               | 移除，wrap 中不调用 `next()` 即可实现  |
| `overrideResult`   | —               | 移除，wrap 中直接返回替代结果即可      |

---

## 4. 执行流程

```
request（用户消息）
  │
  ▼
beforeAgent hooks（顺序执行）
  │
  ▼
┌─── Agent Loop（每轮循环）────────────────────────┐
│                                                   │
│  beforeModel hooks（顺序执行）                     │
│    │                                              │
│    ▼                                              │
│  wrapModelCall 洋葱链 → 实际模型调用               │
│    │                                              │
│    ▼                                              │
│  afterModel hooks（顺序执行）                      │
│    │                                              │
│    ▼                                              │
│  若有 tool_calls：                                 │
│    wrapToolCall 洋葱链 → 实际工具执行（每个调用）    │
│    │                                              │
│    ▼                                              │
│  有工具结果 → 继续下一轮；无 tool_calls → 退出循环  │
│                                                   │
└───────────────────────────────────────────────────┘
  │
  ▼
afterAgent hooks（顺序执行，finally 语义）
  │
  ▼
result
```

---

## 5. Context 设计

### 5.1 RunContext（模型调用阶段）

```ts
interface RunContext {
  // === 会话状态（可变引用，修改会持久化）===
  state: AgentState

  // === 模型调用投影（每轮重置，中间件可改写）===
  /** 即将发给模型的消息列表（修改只影响本次调用，不修改历史） */
  callMessages: AgentMessage[]
  /** 即将发给模型的 system prompt */
  system: string
  /** 即将发给模型的工具定义列表 */
  tools: ToolDefinition[]

  // === 模型响应（afterModel 阶段可读）===
  lastResponse?: ChatResponse

  // === 只读元信息 ===
  readonly turnIndex: number
  readonly provider: LLMProvider
  readonly signal: AbortSignal
}
```

### 5.2 ToolCallContext（工具执行阶段）

```ts
interface ToolCallContext extends RunContext {
  readonly toolCallId: string
  readonly toolName: string
  readonly toolInput: Record<string, unknown>
}
```

相比旧设计，`ToolCallContext` 不再包含 `skipExecution`、`overrideResult`、`toolResult` 等控制/结果字段——这些逻辑全部内化在 `wrapToolCall` 中。

---

## 6. 中间件状态管理

### 6.1 公私分离原则

中间件的状态分为两类：

| 类型         | 存储位置                          | 可见性         | 是否持久化                   | 示例                              |
| ------------ | --------------------------------- | -------------- | ---------------------------- | --------------------------------- |
| **私有状态** | class 实例属性                    | 仅中间件自身   | 否（随实例生命周期）         | 内部计数器、配置参数、prompt 模板 |
| **公有状态** | `this.state`（同步到 AgentState） | 所有中间件可读 | 是（跟随 AgentState 序列化） | 摘要文本、压缩计数、统计数据      |

### 6.2 同步机制：共享引用

采用最简单的共享引用方案——框架在创建中间件时，将 `middleware.state` 直接挂载到 `AgentState.middlewareStates[name]`，两者引用同一对象：

```ts
// Agent 创建阶段（框架内部逻辑）
const mw = new SummarizerMiddleware()
agentState.middlewareStates[mw.name] = mw.state // 共享同一引用

// 中间件内部读写 this.state，外部通过 agentState.middlewareStates 也能看到
```

Session 恢复时，从持久化的 AgentState 反向灌入：

```ts
// 从持久化数据恢复
Object.assign(mw.state, agentState.middlewareStates[mw.name])
// 重新建立引用
agentState.middlewareStates[mw.name] = mw.state
```

### 6.3 AgentState 扩展

```ts
interface AgentState {
  messages: AgentMessage[]
  usage: Usage
  metadata: Map<string, unknown>
  /** 各中间件的公有状态（按中间件 name 索引，支持序列化持久化） */
  middlewareStates: Record<string, Record<string, unknown>>
}
```

### 6.4 约束

- `state` 字段的内容**必须可 JSON 序列化**（不能包含 Map、Set、函数、类实例等）
- 中间件的 `name` 必须唯一，作为 `middlewareStates` 的 key
- 中间件之间读取彼此的公有状态通过 `ctx.state.middlewareStates[name]` 访问

### 6.5 完整示例

```ts
class SummarizerMiddleware extends AgentMiddleware {
  name = 'summarizer'

  // === 公有状态：自动同步到 AgentState，其他中间件可读，支持持久化 ===
  state = {
    summary: '',
    compressedCount: 0,
    lastSummarizedAt: -1,
  }

  // === 私有状态：仅自身可见，不持久化 ===
  private summaryPrompt = 'Summarize the following conversation...'
  private compressionThreshold = 50

  beforeModel(ctx: RunContext) {
    // 读取自己的公有状态
    if (ctx.callMessages.length > this.compressionThreshold) {
      // 私有配置驱动逻辑
      const newSummary = this.doSummarize(ctx.callMessages, this.summaryPrompt)
      // 写入公有状态（自动反映到 AgentState）
      this.state.summary = newSummary
      this.state.compressedCount++
      this.state.lastSummarizedAt = ctx.turnIndex
    }

    // 将摘要注入 system prompt
    if (this.state.summary) {
      ctx.system += `\n\nConversation summary:\n${this.state.summary}`
    }
  }
}

// 其他中间件读取摘要
class AnalyticsMiddleware extends AgentMiddleware {
  name = 'analytics'
  state = { totalTurns: 0 }

  afterModel(ctx: RunContext) {
    this.state.totalTurns++
    // 读取 summarizer 的公有状态
    const summarizerState = ctx.state.middlewareStates['summarizer']
    if (summarizerState?.summary) {
      console.log(`Current summary length: ${summarizerState.summary.length}`)
    }
  }
}
```

---

## 7. Hook 与 Wrap 的职责边界

### 7.1 Hook 适用场景

| Hook          | 典型用途                                                            |
| ------------- | ------------------------------------------------------------------- |
| `beforeAgent` | 加载用户偏好、初始化统计计数器、设置 metadata                       |
| `afterAgent`  | 持久化统计数据、清理临时资源、记录最终 usage                        |
| `beforeModel` | 上下文压缩（截断/摘要旧消息）、动态注入工具定义、追加 system prompt |
| `afterModel`  | 记录 token 使用量、日志记录、更新 state 中的元信息                  |

### 7.2 Wrap 适用场景

| Wrap            | 典型用途                                                                 |
| --------------- | ------------------------------------------------------------------------ |
| `wrapModelCall` | 请求重试、响应缓存、限流/令牌桶、错误分类与降级                          |
| `wrapToolCall`  | 权限审批（不调用 `next()` 直接拒绝）、执行超时、结果截断、参数重写、熔断 |

### 7.3 明确的禁止事项

- **Hook 中不要做行为控制**：不要在 Hook 中决定"跳过执行"或"替换结果"
- **Wrap 中不要做无关的状态修改**：Wrap 只关注被包裹的操作本身

---

## 8. Pipeline 执行器

```ts
class MiddlewarePipeline {
  constructor(private readonly middlewares: AgentMiddleware[]) {}

  // Hook 执行器：顺序调用
  async runBeforeAgent(ctx: RunContext): Promise<void>
  async runAfterAgent(ctx: RunContext): Promise<void> // 吞异常，finally 语义
  async runBeforeModel(ctx: RunContext): Promise<void>
  async runAfterModel(ctx: RunContext): Promise<void>

  // Wrap 链构建器：洋葱模型
  buildModelCallChain(baseFn: ModelCallFn): ModelCallFn
  buildToolCallChain(baseFn: ToolCallFn): ToolCallFn
}
```

**洋葱模型构建**：从后往前 `reduceRight`，最先注册的中间件在最外层。

```ts
buildModelCallChain(baseFn: ModelCallFn): ModelCallFn {
  return this.middlewares.reduceRight<ModelCallFn>((next, mw) => {
    if (!mw.wrapModelCall) return next
    return (ctx) => Promise.resolve(mw.wrapModelCall!(next, ctx))
  }, baseFn)
}
```

---

## 9. 与 Agent Loop 的集成

Agent Loop 中的简化伪代码：

```ts
async function* runLoop(params, config) {
  const pipeline = new MiddlewarePipeline(config.middleware)
  const ctx = makeRunContext(params, config)

  // Wrap 链在循环外构建一次（中间件列表不变）
  const wrappedModelCall = pipeline.buildModelCallChain(baseModelCall)
  const wrappedToolCall = pipeline.buildToolCallChain(baseToolCall)

  await pipeline.runBeforeAgent(ctx)

  try {
    while (turnIndex < maxTurns) {
      // 每轮重置投影字段
      ctx.callMessages = [...state.messages]
      ctx.system = system
      ctx.tools = [...toolDefinitions]

      await pipeline.runBeforeModel(ctx)

      const streamResult = await wrappedModelCall(ctx)
      const response = yield* forwardStream(streamResult)
      ctx.lastResponse = response

      await pipeline.runAfterModel(ctx)

      state.messages.push({ role: 'assistant', content: response.content })

      const toolCalls = extractToolCalls(response.content)
      if (toolCalls.length === 0) break

      for (const call of toolCalls) {
        const toolCtx = { ...ctx, toolCallId: call.id, toolName: call.name, toolInput: call.input }
        const output = await wrappedToolCall(toolCtx)
        state.messages.push({ role: 'tool', toolCallId: call.id, content: output.content })
      }

      turnIndex++
    }
  } finally {
    await pipeline.runAfterAgent(ctx)
  }
}
```

**关键设计决策**：

1. **Wrap 链只构建一次**：`buildModelCallChain` 和 `buildToolCallChain` 均在循环外构建，避免每轮重复创建闭包。
2. **`afterModel` 是只读观察点**：不修改 `response` 内容。模型输出直接进入 `state.messages`，中间件无权篡改。
3. **`afterAgent` 具有 finally 语义**：即使 Loop 抛异常也会执行，内部异常不向上传播。

---

## 10. 中间件示例

### 10.1 上下文压缩中间件

```ts
const contextCompressor: AgentMiddleware = {
  name: 'context-compressor',
  beforeModel(ctx) {
    if (estimateTokens(ctx.callMessages) > MAX_CONTEXT_TOKENS) {
      ctx.callMessages = compress(ctx.callMessages)
    }
  },
}
```

### 10.2 重试中间件

```ts
const retryMiddleware: AgentMiddleware = {
  name: 'retry',
  async wrapModelCall(next, ctx) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await next(ctx)
      } catch (err) {
        if (!isRetryable(err) || attempt === 2) throw err
        await delay(1000 * (attempt + 1))
      }
    }
    throw new Error('unreachable')
  },
}
```

### 10.3 权限审批中间件

```ts
const permissionGuard: AgentMiddleware = {
  name: 'permission-guard',
  async wrapToolCall(next, ctx) {
    if (isDangerous(ctx.toolName, ctx.toolInput)) {
      const approved = await askUserApproval(ctx.toolName, ctx.toolInput)
      if (!approved) {
        return { content: '用户拒绝了此操作', isError: true }
      }
    }
    return next(ctx)
  },
}
```

### 10.4 工具结果截断中间件

```ts
const resultTruncator: AgentMiddleware = {
  name: 'result-truncator',
  async wrapToolCall(next, ctx) {
    const output = await next(ctx)
    if (output.content.length > MAX_TOOL_OUTPUT_LENGTH) {
      return { ...output, content: truncate(output.content, MAX_TOOL_OUTPUT_LENGTH) }
    }
    return output
  },
}
```

---

## 11. 设计取舍

### 为什么 afterModel 不能修改模型输出？

1. **流式场景**：模型响应在 `afterModel` 触发前已经通过事件流发送给消费方（UI），修改已无意义
2. **可预测性**：模型输出直接持久化到 `state.messages`，中间件不会产生"消息历史和实际执行不一致"的问题
3. **工具干预有更好的位置**：如果需要拦截/修改工具调用，在 `wrapToolCall` 中做更合适（粒度更细，职责更清晰）

### 为什么移除 beforeToolExec / afterToolExec？

1. **与 wrapToolCall 职责重叠**：`beforeToolExec` 的"权限拦截"和 `afterToolExec` 的"结果截断"都是 wrap 的天然职责
2. **减少声明式标志位**：不再需要 `skipExecution`、`overrideResult` 这些间接控制机制
3. **简化心智模型**：开发者只需记住"Hook 改状态，Wrap 包行为"

### 为什么移除 onTurnEnd？

`onTurnEnd` 的典型用途（统计、清理）可以在 `afterModel` 中完成——它在每轮模型响应后都会触发。如果需要区分"有工具调用的轮次"和"纯文本回复的轮次"，通过 `ctx.lastResponse` 判断即可。
