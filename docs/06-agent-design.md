# Agent 层设计文档

> 版本：v0.1.0 · 日期：2026-05-31

---

## 1. 设计目标

Agent 是 `@mech/core` 的核心运行时引擎，负责编排 LLM 调用、工具分发、中间件执行的完整循环。设计上需要满足以下约束：

- **Agent 无状态**：状态由调用方持有并传入，Agent 只是执行引擎
- **SDK 友好**：同一 Agent 实例可服务于多个并行对话
- **策略外置**：上下文管理、权限、重试等策略逻辑全部通过中间件实现，不侵入 Loop 核心
- **可观测**：通过事件流（`AsyncIterable<AgentEvent>`）暴露完整的内部执行过程

---

## 2. Agent 创建与实例方法

### 2.1 创建方式

通过工厂函数创建，传入**能力配置**（provider + tools + middleware + system prompt）：

```ts
const agent = createAgent({
  provider,
  tools: [readFileTool, searchTool],
  system: 'You are a helpful coding assistant.',
  middleware: [contextManager, permissionGuard],
  maxTurns: 20,
})
```

`AgentConfig` 定义 Agent 的"能力模板"，不包含任何会话状态。

### 2.2 实例方法

```ts
class Agent {
  // === 核心执行 ===

  /** 流式运行，逐事件消费（适合实时 UI 渲染） */
  run(params: RunParams): AsyncIterable<AgentEvent>

  /** 一次性运行，等待最终结果 */
  complete(params: RunParams): Promise<RunResult>

  // === 运行时配置变更 ===

  /** 追加中间件 */
  use(middleware: AgentMiddleware): void

  /** 动态注册工具 */
  addTool(tool: Tool): void

  /** 动态移除工具 */
  removeTool(name: string): void

  /** 基于当前 Agent 派生新实例（覆盖部分配置，适合子任务 Agent） */
  fork(overrides: Partial<AgentConfig>): Agent
}
```

### 2.3 `fork` 场景示例

```ts
// 主 Agent 拥有全部工具
const mainAgent = createAgent({ provider, tools: allTools, system: '...' })

// 派生一个只读子 Agent（摘要任务不需要写工具）
const summaryAgent = mainAgent.fork({
  tools: readOnlyTools,
  system: '你是一个摘要助手，只需阅读和总结内容。',
  maxTurns: 3,
})
```

---

## 3. Agent State —— 外部持有的会话状态

### 3.1 设计原则

**状态所有权在调用方**。每次调用 `run()`，业务层传入完整的 `AgentState`，Agent 在执行过程中直接修改此状态（追加消息、累加用量等），执行结束后调用方无需手动同步。

### 3.2 State 结构

```ts
interface AgentState {
  // === 框架约定字段 ===
  /** 完整消息历史（只增不减，压缩时仅打标记） */
  messages: Message[]
  /** 被压缩消息的摘要文本（由摘要中间件维护） */
  summary?: string
  /** 累计 token 用量 */
  usage: Usage

  // === 扩展字段 ===
  /** 中间件/工具自由读写的共享状态 */
  store: Record<string, unknown>
}
```

### 3.3 调用方式

```ts
// 业务层持有 state
const state: AgentState = {
  messages: [],
  usage: { inputTokens: 0, outputTokens: 0 },
  store: {},
}

// 第一轮对话
state.messages.push({ role: 'user', content: '你好' })
for await (const event of agent.run({ state })) {
  // 处理事件...
}
// 此时 state.messages 已包含 assistant 回复和 tool 消息
// state.usage 已累加本次用量

// 第二轮对话 —— 同一个 state 继续
state.messages.push({ role: 'user', content: '继续上面的任务' })
for await (const event of agent.run({ state })) { ... }
```

### 3.4 RunParams 与 RunResult

```ts
interface RunParams {
  state: AgentState
  maxTurns?: number // 覆盖 AgentConfig 中的默认值
  signal?: AbortSignal
}

interface RunResult {
  /** 最后一轮 assistant 的文本输出 */
  text: string
  /** 终止原因 */
  stopReason: 'end_turn' | 'max_turns' | 'error' | 'abort'
  /** 本次 run 的增量 token 用量 */
  usage: Usage
  /** 本次 run 执行的轮次数 */
  turnsUsed: number
}
```

注意 `RunResult` 不再返回 `messages`——因为 `state` 是 mutable 引用，调用方已持有完整状态。

---

## 4. 中间件与 Loop 的融合

### 4.1 核心原则

**Loop 是状态机，中间件通过 Context 上的信号量影响状态转移。** Loop 拥有控制流，中间件不直接操控循环逻辑。

### 4.2 两种集成模式

#### Hook 模式 —— 观察与修改数据

适用于大多数生命周期钩子。中间件被通知，通过修改 Context 间接影响 Loop 行为：

```ts
beforeLLMCall(ctx) {
  // 修改 ctx.callMessages 做上下文压缩
  ctx.callMessages = ctx.callMessages.filter(m => !m._compressed)
}
```

#### Wrap 模式 —— 包裹核心操作

适用于 LLM 调用和工具执行。中间件包裹原操作，获得完整执行控制权（重试、缓存、熔断）：

```ts
async *wrapLLMCall(next, ctx) {
  for (let i = 0; i < 3; i++) {
    try { yield* next(ctx); return }
    catch (e) { if (!isRetryable(e) || i === 2) throw e }
  }
}
```

### 4.3 中间件接口（更新版）

```ts
interface AgentMiddleware {
  name: string

  // === Hook 式（观察 + 修改数据）===
  onRunStart?(ctx: RunContext): Awaitable<void>
  onTurnEnd?(ctx: RunContext): Awaitable<void>
  onRunEnd?(ctx: RunContext): Awaitable<void>

  beforeLLMCall?(ctx: RunContext): Awaitable<void>
  afterLLMResponse?(ctx: RunContext): Awaitable<void>
  beforeToolExec?(ctx: ToolExecContext): Awaitable<void>
  afterToolExec?(ctx: ToolExecContext): Awaitable<void>

  // === Wrap 式（包裹核心操作）===
  wrapLLMCall?(next: LLMCallFn, ctx: RunContext): AsyncIterable<AgentEvent>
  wrapToolExec?(next: ToolExecFn, ctx: ToolExecContext): Awaitable<ToolOutput>
}

type Awaitable<T> = T | Promise<T>
type LLMCallFn = (ctx: RunContext) => AsyncIterable<AgentEvent>
type ToolExecFn = (ctx: ToolExecContext) => Promise<ToolOutput>
```

### 4.4 RunContext（中间件上下文）

```ts
interface RunContext {
  // === 完整状态（可变引用）===
  state: AgentState

  // === LLM 调用投影（每轮重新生成，中间件可改写）===
  callMessages: Message[] // 即将发给 LLM 的消息（从 state.messages 快照）
  system: string // 即将发给 LLM 的 system prompt
  tools: ToolDefinition[] // 即将发给 LLM 的工具列表

  // === LLM 响应（afterLLMResponse 阶段可读）===
  lastResponse?: ChatResponse

  // === 只读信息 ===
  readonly turnIndex: number
  readonly provider: ProviderConfig
  readonly signal: AbortSignal
}
```

关键设计：`state` 是全局可变引用，`callMessages` 是每轮的临时投影。中间件修改 `callMessages` 只影响本次 LLM 调用，不影响真实消息历史。

### 4.5 ToolExecContext

```ts
interface ToolExecContext extends RunContext {
  toolCallId: string
  toolName: string
  toolInput: Record<string, unknown>

  /** afterToolExec 阶段可读取工具的实际输出 */
  toolResult?: ToolOutput

  /** 设为 true 则跳过工具执行（由权限中间件在 beforeToolExec 中设置） */
  skipExecution?: boolean

  /** 覆盖工具输出，跳过执行时作为替代结果返回 */
  overrideResult?: ToolOutput
}
```

### 4.6 Pipeline 执行机制

`MiddlewarePipeline` 负责两件事：

1. **顺序执行 Hook**：按注册顺序依次调用，某个 Hook 抛异常则终止整条链
2. **构建 Wrap 链**：将多个中间件的 `wrapLLMCall` / `wrapToolExec` 串成洋葱

```ts
class MiddlewarePipeline {
  /** 按注册顺序执行 Hook */
  async runHook(hookName: string, ctx: RunContext): Promise<void>

  /** 从后往前包裹，最先注册的中间件在最外层 */
  buildLLMCallChain(baseFn: LLMCallFn): LLMCallFn
  buildToolExecChain(baseFn: ToolExecFn): ToolExecFn
}
```

Wrap 链构建：

```ts
buildLLMCallChain(baseFn: LLMCallFn): LLMCallFn {
  return this.middlewares.reduceRight(
    (next, mw) => {
      if (!mw.wrapLLMCall) return next
      return (ctx) => mw.wrapLLMCall!(next, ctx)
    },
    baseFn,
  )
}
```

### 4.7 Hook 与 Wrap 的执行顺序

```
beforeLLMCall hooks（按注册顺序）  →  准备 callMessages / system
        ↓
wrapLLMCall 洋葱链                 →  重试、缓存、限流等
        ↓
实际 LLM 调用（baseFn）
        ↓
afterLLMResponse hooks（按注册顺序）→  响应后处理
```

**Hook 先于 Wrap 执行**——确保数据准备（如消息过滤、上下文注入）在操作包裹（如重试）之前完成。重试时不会重复执行 Hook，只会重复 baseFn。

---

## 5. Agent Loop 状态机

### 5.1 阶段划分

```
┌─────────────────────────────────────────────────────┐
│  RUN START                                          │
│  ┌───────────────────────────────────────────────┐  │
│  │  TURN                                         │  │
│  │                                               │  │
│  │  ┌─────────┐   ┌──────────┐   ┌───────────┐  │  │
│  │  │ PREPARE │──▶│ LLM CALL │──▶│  DISPATCH │  │  │
│  │  └─────────┘   └──────────┘   └─────┬─────┘  │  │
│  │       ▲                             │         │  │
│  │       │         ┌───────────┐       │         │  │
│  │       └─────────│ TOOL EXEC │◀──────┘         │  │
│  │                 └───────────┘                  │  │
│  └───────────────────────────────────────────────┘  │
│  RUN END                                            │
└─────────────────────────────────────────────────────┘
```

| 阶段          | 职责                                                                    |
| ------------- | ----------------------------------------------------------------------- |
| **PREPARE**   | 从 `state.messages` 生成 `callMessages` 快照，执行 `beforeLLMCall` Hook |
| **LLM CALL**  | 经过 Wrap 链调用 Provider，转发流式事件                                 |
| **DISPATCH**  | 解析 LLM 响应，判断是否有工具调用                                       |
| **TOOL EXEC** | 执行工具调用（经过 Wrap 链 + Hook），结果追加到 `state.messages`        |

### 5.2 Loop 伪代码

```ts
async function* runLoop(state: AgentState, config: AgentConfig): AsyncGenerator<AgentEvent> {
  const pipeline = new MiddlewarePipeline(config.middleware)
  const ctx = createRunContext(state, config)

  yield { type: 'agent_run_start', runId, messages: state.messages }
  await pipeline.runHook('onRunStart', ctx)

  while (ctx.turnIndex < ctx.maxTurns && !ctx.signal.aborted) {
    yield { type: 'turn_start', turnIndex: ctx.turnIndex }

    // ---- PREPARE ----
    ctx.callMessages = [...state.messages]
    ctx.system = config.system
    ctx.tools = getToolDefinitions(config.tools)

    await pipeline.runHook('beforeLLMCall', ctx)

    // ---- LLM CALL ----
    const baseLLMCall: LLMCallFn = (ctx) =>
      provider.stream({
        messages: normalize(ctx.callMessages),
        system: ctx.system,
        tools: ctx.tools,
      })

    const wrappedLLMCall = pipeline.buildLLMCallChain(baseLLMCall)
    const response = yield* forwardStreamEvents(wrappedLLMCall(ctx))

    ctx.lastResponse = response
    await pipeline.runHook('afterLLMResponse', ctx)

    // 追加 assistant 消息到真实状态
    state.messages.push(toAssistantMessage(response))
    accumulate(state.usage, response.usage)

    // ---- DISPATCH ----
    const toolCalls = extractToolCalls(response)

    if (!toolCalls.length || response.stopReason === 'end_turn') {
      await pipeline.runHook('onTurnEnd', ctx)
      yield { type: 'turn_end', turnIndex: ctx.turnIndex, usage: response.usage }
      break
    }

    // ---- TOOL EXEC ----
    const baseToolExec: ToolExecFn = (toolCtx) => executeTool(toolCtx)
    const wrappedToolExec = pipeline.buildToolExecChain(baseToolExec)

    // 根据 parallelSafe 标记分组：并发安全的并行执行，其余串行
    const results = await dispatchToolCalls(toolCalls, ctx, wrappedToolExec)

    for (const result of results) {
      state.messages.push(toToolMessage(result))
    }

    await pipeline.runHook('onTurnEnd', ctx)
    yield { type: 'turn_end', turnIndex: ctx.turnIndex, usage: response.usage }

    ctx.turnIndex++
  }

  // 判定终止原因
  const stopReason = resolveStopReason(ctx)

  await pipeline.runHook('onRunEnd', ctx)
  yield { type: 'agent_run_end', runId, usage: state.usage, stopReason, messages: state.messages }
}
```

### 5.3 工具并发调度

```ts
async function dispatchToolCalls(
  toolCalls: ToolCall[],
  ctx: RunContext,
  wrappedExec: ToolExecFn,
): Promise<ToolResult[]> {
  // 按 parallelSafe 分组
  const { parallel, sequential } = groupByParallelSafe(toolCalls)

  // 并发安全的工具同时执行
  const parallelResults = await Promise.all(
    parallel.map((call) => executeWithMiddleware(call, ctx, wrappedExec)),
  )

  // 非并发安全的工具按序执行
  const sequentialResults: ToolResult[] = []
  for (const call of sequential) {
    const result = await executeWithMiddleware(call, ctx, wrappedExec)
    sequentialResults.push(result)
  }

  return [...parallelResults, ...sequentialResults]
}
```

---

## 6. 循环终止策略

### 6.1 终止条件

| 条件                 | stopReason  | 说明                          |
| -------------------- | ----------- | ----------------------------- |
| LLM 返回 `end_turn`  | `end_turn`  | 模型认为任务完成              |
| 达到 `maxTurns` 上限 | `max_turns` | 防止无限循环                  |
| `AbortSignal` 触发   | `abort`     | 用户主动中止                  |
| 不可恢复的错误       | `error`     | Provider 错误、工具致命错误等 |

### 6.2 内建保护（Loop 层实现）

- **maxTurns 硬限制**：默认 20 轮，可通过 `AgentConfig` 或 `RunParams` 覆盖
- **AbortSignal 传播**：贯穿 LLM 调用和工具执行，确保中止信号及时响应

### 6.3 策略性终止（中间件实现）

以下终止逻辑不内建在 Loop 中，而是通过中间件实现：

**Token 预算中间件**：

```ts
const tokenBudgetMiddleware: AgentMiddleware = {
  name: 'token-budget',
  afterLLMResponse(ctx) {
    const total = ctx.state.usage.inputTokens + ctx.state.usage.outputTokens
    if (total > maxBudget) {
      // 通过 abort signal 通知 Loop 终止
      ctx.signal.abort('token_budget_exceeded')
    }
  },
}
```

**死循环检测中间件**：

```ts
const loopDetectionMiddleware: AgentMiddleware = {
  name: 'loop-detection',
  beforeToolExec(ctx) {
    // 检测连续多轮调用相同工具 + 相同输入
    const history = ctx.state.metadata.get('tool_call_history') as ToolCallRecord[]
    if (isRepeating(history, ctx.toolName, ctx.toolInput, threshold)) {
      ctx.skipExecution = true
      ctx.overrideResult = {
        content: '检测到重复调用，请尝试其他方法。',
        isError: true,
      }
    }
  },
}
```

---

## 7. 消息窗口管理（上下文压缩）

### 7.1 设计理念

上下文窗口管理是策略逻辑，完全在中间件层实现。Loop 不感知压缩的存在。

### 7.2 消息标记机制

在内部消息类型上扩展一个可选标记：

```ts
interface InternalMessage extends Message {
  /** 被摘要压缩过的消息，发送给 LLM 前应过滤 */
  _compressed?: true
}
```

### 7.3 压缩工作流

```
state.messages:  [m1, m2, m3, m4, m5, m6, m7, m8]
                  ^^^^^^^^^^
                  标记为 _compressed

state.summary:   "用户询问了项目结构，助手解释了 monorepo 布局..."

实际发给 LLM:   system + <summary>...</summary> + [m4, m5, m6, m7, m8]
```

### 7.4 摘要中间件实现

```ts
const summarizeMiddleware: AgentMiddleware = {
  name: 'summarize',

  beforeLLMCall(ctx) {
    const { state } = ctx
    const totalTokens = estimateTokens(state.messages)

    if (totalTokens > tokenThreshold) {
      // 1. 选取要压缩的旧消息（保留最近 N 轮）
      const toCompress = selectOldMessages(state.messages)

      // 2. 生成增量摘要（合并已有 summary + 新压缩内容）
      state.summary = compress(state.summary, toCompress)

      // 3. 标记而非删除
      toCompress.forEach((m) => (m._compressed = true))
    }

    // 4. 构建投影：过滤已压缩消息 + 注入摘要
    ctx.callMessages = state.messages.filter((m) => !m._compressed)
    if (state.summary) {
      ctx.system += `\n\n<conversation_summary>\n${state.summary}\n</conversation_summary>`
    }
  },
}
```

### 7.5 方案优势

| 特性           | 说明                                                          |
| -------------- | ------------------------------------------------------------- |
| **可审计**     | `state.messages` 始终保留完整历史，被压缩的消息仍然存在       |
| **可恢复**     | 切换到更大上下文窗口的模型时，可清除 `_compressed` 标记       |
| **渐进式**     | 每次只压缩一批旧消息，summary 增量更新，不需要重新摘要全部    |
| **关注点分离** | Loop 完全不知道压缩的存在，只管往 `state.messages` 追加新消息 |

---

## 8. 错误处理

### 8.1 错误分类

| 类型                   | 来源     | 处理方式                            |
| ---------------------- | -------- | ----------------------------------- |
| Provider 网络/限流错误 | LLM 调用 | 通过 `wrapLLMCall` 中间件重试       |
| 无效 tool_use          | LLM 输出 | 将错误作为 tool role 消息反馈给 LLM |
| 工具执行失败           | 工具代码 | 反馈给 LLM，给自我修正机会          |
| 不可恢复错误           | 任意阶段 | 终止 run，`stopReason: 'error'`     |

### 8.2 工具错误自愈

当工具执行失败时，Loop 将错误信息作为 `tool` role 消息追加到 `state.messages`，让 LLM 在下一轮尝试修正。但设置上限——同一工具连续失败超过阈值则终止：

```ts
// Loop 内部逻辑
const result = await wrappedToolExec(toolCtx)

state.messages.push({
  role: 'tool',
  toolCallId: call.id,
  content: result.isError ? `Error: ${result.content}` : result.content,
})
// 继续循环 → LLM 看到错误后可自行修正调用
```

### 8.3 中间件异常传播

- Hook 阶段某个中间件抛异常 → 终止当前 Hook 链，Loop 进入错误处理
- Wrap 链中某层抛异常 → 冒泡到外层 Wrap（外层可 catch 并重试），最终未捕获则终止 Loop
- `onRunEnd` Hook 即使前序出错也应执行（类似 `finally`），确保清理逻辑不被跳过

---

## 9. 中间件实战示例

### 9.1 重试中间件（Wrap 模式）

```ts
const retryMiddleware: AgentMiddleware = {
  name: 'retry',
  async *wrapLLMCall(next, ctx) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        yield* next(ctx)
        return
      } catch (e) {
        if (!(e instanceof ProviderError) || !e.retryable || attempt === 2) throw e
        await delay(1000 * 2 ** attempt)
      }
    }
  },
}
```

### 9.2 权限中间件（Wrap 模式）

```ts
const permissionMiddleware: AgentMiddleware = {
  name: 'permission',
  async wrapToolExec(next, ctx) {
    const tool = getTool(ctx.toolName)
    if (!tool?.flags.readonly) {
      const ok = await askUser(`允许执行 ${ctx.toolName}？`)
      if (!ok) return { content: '用户已拒绝此操作', isError: true }
    }
    return next(ctx)
  },
}
```

### 9.3 日志中间件（Hook 模式）

```ts
const loggerMiddleware: AgentMiddleware = {
  name: 'logger',
  beforeLLMCall(ctx) {
    console.log(`[Turn ${ctx.turnIndex}] 发送 ${ctx.callMessages.length} 条消息`)
  },
  afterLLMResponse(ctx) {
    const { inputTokens, outputTokens } = ctx.lastResponse!.usage
    console.log(`[Turn ${ctx.turnIndex}] token: ${inputTokens} in / ${outputTokens} out`)
  },
}
```

---

## 10. 类型定义汇总

```ts
// === Agent 配置 ===
interface AgentConfig {
  provider: ProviderConfig
  tools?: Tool[]
  system?: string
  middleware?: AgentMiddleware[]
  maxTurns?: number // 默认 20
}

// === Agent 状态 ===
interface AgentState {
  messages: Message[]
  summary?: string
  usage: Usage
  store: Record<string, unknown>
}

// === 运行参数 ===
interface RunParams {
  state: AgentState
  maxTurns?: number
  signal?: AbortSignal
}

// === 运行结果 ===
interface RunResult {
  text: string
  stopReason: 'end_turn' | 'max_turns' | 'error' | 'abort'
  usage: Usage // 本次增量用量
  turnsUsed: number
}

// === 中间件上下文 ===
interface RunContext {
  state: AgentState
  callMessages: Message[]
  system: string
  tools: ToolDefinition[]
  lastResponse?: ChatResponse
  readonly turnIndex: number
  readonly provider: ProviderConfig
  readonly signal: AbortSignal
}

interface ToolExecContext extends RunContext {
  toolCallId: string
  toolName: string
  toolInput: Record<string, unknown>
  toolResult?: ToolOutput
  skipExecution?: boolean
  overrideResult?: ToolOutput
}

// === 中间件接口 ===
interface AgentMiddleware {
  name: string
  onRunStart?(ctx: RunContext): Awaitable<void>
  onTurnEnd?(ctx: RunContext): Awaitable<void>
  onRunEnd?(ctx: RunContext): Awaitable<void>
  beforeLLMCall?(ctx: RunContext): Awaitable<void>
  afterLLMResponse?(ctx: RunContext): Awaitable<void>
  beforeToolExec?(ctx: ToolExecContext): Awaitable<void>
  afterToolExec?(ctx: ToolExecContext): Awaitable<void>
  wrapLLMCall?(next: LLMCallFn, ctx: RunContext): AsyncIterable<AgentEvent>
  wrapToolExec?(next: ToolExecFn, ctx: ToolExecContext): Awaitable<ToolOutput>
}

type Awaitable<T> = T | Promise<T>
type LLMCallFn = (ctx: RunContext) => AsyncIterable<AgentEvent>
type ToolExecFn = (ctx: ToolExecContext) => Promise<ToolOutput>
```

---

## 11. 设计原则总结

| 原则                                  | 说明                                                       |
| ------------------------------------- | ---------------------------------------------------------- |
| **Agent 无状态**                      | Agent 是能力模板，不持有会话数据；State 由调用方管理       |
| **Loop 拥有控制流**                   | 中间件不直接操控循环逻辑，只通过 Context 信号量影响行为    |
| **Hook 观察数据，Wrap 包裹操作**      | 不要用 Hook 做重试，不要用 Wrap 做日志                     |
| **beforeXxx Hook 先于 Wrap**          | 数据准备在操作包裹之前完成，重试不会重复执行 Hook          |
| **State 是真相，callMessages 是投影** | 每轮从 `state.messages` 生成快照，中间件修改投影不影响历史 |
| **标记而非删除**                      | 压缩消息打标记保留，保证可审计、可恢复                     |
| **计量内建，决策外放**                | Loop 追踪 usage，终止策略交给中间件                        |
| **onRunEnd 类似 finally**             | 即使出错也执行，确保清理逻辑不被跳过                       |
