# HITL（Human-in-the-Loop）暂停与恢复设计文档

> 版本：v0.3.0 · 日期：2026-05-31

---

## 1. 设计目标

为 Agent Loop 提供统一的**中断（interrupt）与恢复（resume）**机制，满足以下场景：

- 工具执行前需要人工审批（权限中间件触发中断）
- 业务层主动中断（用户按 Ctrl+C、补充消息等）
- 长时间等待人工决策（可能跨进程/重启）
- Session 状态可序列化持久化，恢复时从断点继续

### 统一中断模型

从业务层视角看，"暂停（suspend）"和"中断（abort）"本质相同——都是终止当前 Agent Loop，后续都可能希望恢复执行。因此本设计将两者统一为 **interrupt** 概念：

- **所有非正常退出的 loop（工具执行阶段）都生成 `SessionCheckpoint`**
- 差异放在 `reason` 字段（`'approval_required'` vs `'user_abort'` vs `'timeout'` 等）
- 消费方通过 reason 决定 UI 展示和恢复策略
- 恢复路径统一通过 `agent.resume()` 执行

### 核心约束

- **支持跨进程恢复**：中断时状态完全序列化，恢复时从数据重建
- **Loop 保持控制权**：中断/恢复逻辑由 Loop 统一编排，中间件只负责声明"我要挂起"
- **不侵入正常流程**：无 HITL 需求时，Loop 的执行路径不受影响

---

## 2. 核心概念

### 2.1 中断触发方式

Loop 的中断有两种触发来源，但**产生的结果一致**（都生成 checkpoint）：

#### 2.1.1 SuspendSignal（中间件发起）

中间件通过在 `wrapToolCall` 中抛出 `SuspendSignal` 来声明"需要中断"：

```ts
class SuspendSignal extends Error {
  constructor(
    /** 中断原因（业务层用于展示） */
    public readonly reason: string,
    /** 附带的业务数据（如待审批的工具信息） */
    public readonly payload?: Record<string, unknown>,
  ) {
    super(`SuspendSignal: ${reason}`)
    this.name = 'SuspendSignal'
  }
}
```

SuspendSignal 不是普通错误，Loop 捕获后不会走 error 路径，而是进入 interrupt 流程。

#### 2.1.2 AbortSignal（业务层发起）

业务层通过 `AbortSignal` 主动中断 loop。当 abort 发生在**工具执行阶段**时（assistant 消息已写入 state、但 tool results 尚未完成），Loop 同样生成 checkpoint，将未完成的 tool calls 记录为 pending。

```ts
const controller = new AbortController()
// 业务层在任意时机触发中断
controller.abort('user_interrupt')
```

### 2.2 SessionCheckpoint

中断时 Loop 生成的快照，包含恢复执行所需的全部信息：

```ts
interface SessionCheckpoint {
  /** 中断时的完整会话状态（含已执行工具的结果） */
  state: SerializableAgentState
  /** 中断时未完成的 tool calls（恢复时从这里继续执行） */
  pendingToolCalls: PendingToolCall[]
  /** 中断原因（如 'approval_required'、'user_abort'、'timeout'） */
  reason: string
  /** 附带的业务数据 */
  payload?: Record<string, unknown>
  /** 中断时的轮次索引 */
  turnIndex: number
  /** 时间戳 */
  suspendedAt: number
}

interface PendingToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}
```

> **注意**：当 `pendingToolCalls` 为空数组时，表示中断发生在非工具执行阶段（如循环顶部的 abort 检查）。恢复时 Loop 将直接进入下一轮循环。

### 2.3 ResumeParams

恢复时业务层传入的决策信息：

```ts
interface ResumeParams {
  /** 从哪个 checkpoint 恢复 */
  checkpoint: SessionCheckpoint
  /** 人工决策结果（按 toolCallId 索引） */
  decisions: Record<string, ToolCallDecision>
  /** 最大轮数（可选，覆盖默认） */
  maxTurns?: number
  signal?: AbortSignal
}

type ToolCallDecision =
  | { action: 'approve' } // 批准执行
  | { action: 'deny'; reason?: string } // 拒绝
  | { action: 'modify'; input: Record<string, unknown> } // 修改参数后执行
```

---

## 3. 执行流程

### 3.1 正常流程（无中断）

```
agent.run({ state }) → Loop 正常运行 → agent_run_end (stopReason: 'end_turn')
```

### 3.2 中间件触发中断（SuspendSignal）

```
agent.run({ state })
  │
  ▼
Loop 执行中...
  │
  ├─ model call → response (含 tool_calls [A, B, C])
  │
  ├─ wrapToolCall(A) → 正常执行，结果写入 state
  │
  ├─ wrapToolCall(B) → 中间件抛出 SuspendSignal
  │
  ▼
Loop 捕获 SuspendSignal：
  1. 已完成的 tool A 结果已在 state.messages 中
  2. 收集未执行的 pending calls: [B, C]
  3. 生成 SessionCheckpoint
  4. yield { type: 'suspended', checkpoint }
  5. Loop 正常退出（stopReason: 'suspended'）
```

### 3.3 业务层触发中断（AbortSignal）

中断可能发生在 Loop 的不同阶段，处理策略不同：

#### 工具执行阶段的 Abort

assistant 消息已写入 state，存在未执行的 tool calls：

```
agent.run({ state, signal })
  │
  ├─ model call → response (含 tool_calls [A, B, C])
  ├─ assistant 消息写入 state ✓
  ├─ executeToolBatch 执行中...
  │   ├─ tool A 执行完毕 ✓（结果暂存）
  │   ├─ tool B 执行中... → signal.abort() 触发
  │
  ▼
executeToolBatch 检测到 abort：
  1. 收集未完成的 pending calls: [B, C]（或 [C] 如果 B 已完成）
  2. 生成 SessionCheckpoint (reason: 'user_abort')
  3. 返回 { status: 'suspended', event }
  4. 主循环 yield suspended 事件，退出（stopReason: 'suspended'）
```

#### 模型流式输出阶段的 Abort

assistant 消息**尚未写入** state（仅在流完成后才追加），state 保持干净：

```
agent.run({ state, signal })
  │
  ├─ model call → 流式输出中... → signal.abort() 触发
  │
  ▼
Provider 取消流 → 异常传播：
  - state 不含半截消息（assistant 消息未写入）
  - 不生成 checkpoint（无 pending 内容需要决策）
  - Loop 退出（stopReason: 'abort'）
  - 业务层可直接追加 user message 后重新 run()
```

> **关键设计**：assistant 消息仅在流式完成后才写入 state。这保证了流式期间的 abort 不会污染 state，无需 checkpoint。

### 3.4 恢复流程

```
agent.resume(checkpoint, { decisions })
  │
  ▼
新的 Loop 启动：
  1. 从 checkpoint.state 恢复上下文
  2. 根据 decisions 处理 pending tool calls：
     - approve → 执行 wrapToolCall
     - deny → 写入拒绝结果到 state
     - modify → 用新 input 执行 wrapToolCall
  3. pending calls 全部处理完后，进入正常 Loop 循环
  4. 继续 model call → tool dispatch → ...
```

> 当 `pendingToolCalls` 为空（来自无 pending 的 abort 恢复场景），阶段 2 跳过，直接进入循环。

---

## 4. API 设计

### 4.1 Agent 接口扩展

```ts
class Agent {
  /** 正常运行（现有 API，不变） */
  async *run(params: RunParams): AsyncIterable<AgentEvent>

  /** 从 checkpoint 恢复运行 */
  async *resume(params: ResumeParams): AsyncIterable<AgentEvent>

  /** 一次性运行（现有 API，不变） */
  async complete(params: RunParams): Promise<RunResult>
}
```

### 4.2 AgentEvent 扩展

```ts
// 新增事件类型
interface SuspendedEvent {
  type: 'suspended'
  checkpoint: SessionCheckpoint
  reason: string
  payload?: Record<string, unknown>
}
```

### 4.3 RunResult 扩展

```ts
interface RunResult {
  text: string
  stopReason: 'end_turn' | 'max_turns' | 'error' | 'abort' | 'suspended'
  usage: Usage
  turnsUsed: number
  /** 中断时的 checkpoint（stopReason === 'suspended' 时有值） */
  checkpoint?: SessionCheckpoint
}
```

> `stopReason` 语义：
>
> - `'end_turn'` — 模型正常结束（无 tool_use）
> - `'max_turns'` — 达到最大轮次
> - `'error'` — 不可恢复错误
> - `'abort'` — 模型流式阶段的中断（state 干净，无需 checkpoint）
> - `'suspended'` — 工具执行阶段的中断（有 pending calls，需通过 resume 恢复）

---

## 5. Loop 内部实现

### 5.1 模块结构

重构后的 `loop.ts` 采用分层架构，消除 `runLoop` 与 `runLoopFromCheckpoint` 之间的重复代码：

```
┌─────────────────────────────────────────────────────┐
│  公共 API                                           │
│  runLoop()  /  runLoopFromCheckpoint()              │
│  （薄包装层：初始化 + 进入主循环 + 收尾）           │
├─────────────────────────────────────────────────────┤
│  runMainLoop()                                      │
│  （主循环引擎：model call → tool dispatch → loop）  │
├─────────────────────────────────────────────────────┤
│  executeToolBatch()                                 │
│  （工具批量执行：并行/串行 + 中断捕获）             │
├─────────────────────────────────────────────────────┤
│  initLoopInfra()                                    │
│  （公共初始化：AbortController、pipeline、toolMap）  │
├─────────────────────────────────────────────────────┤
│  辅助函数                                           │
│  forwardStreamEvents / extractToolCalls / ...       │
└─────────────────────────────────────────────────────┘
```

### 5.2 executeToolBatch —— 统一中断捕获

将并行 + 串行工具执行和 SuspendSignal / AbortSignal 中断处理封装为单一函数，返回联合结果：

```ts
type ToolBatchResult =
  | { status: 'completed'; results: Map<string, ToolOutput> }
  | { status: 'suspended'; event: AgentEvent }

async function executeToolBatch(
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  ctx: RunContext,
  toolMap: Map<string, Tool>,
  wrappedToolCall: ToolCallFn,
  state: AgentState,
  signal: AbortSignal,
  turnIndex: number,
): Promise<ToolBatchResult> {
  const parallelCalls = toolCalls.filter(c => toolMap.get(c.name)?.flags.parallelSafe)
  const sequentialCalls = toolCalls.filter(c => !toolMap.get(c.name)?.flags.parallelSafe)

  // 内部辅助：生成 suspended 事件（含 checkpoint）
  const makeSuspendedEvent = (pendingCalls, reason, payload?) => ({ ... })

  // ---- 并行工具执行 ----
  // 任何中断 → 整批（parallel + sequential）作为 pending
  if (parallelCalls.length > 0) { ... }

  // ---- 串行工具执行 ----
  // 中断 → 当前及后续作为 pending
  for (let i = 0; i < sequentialCalls.length; i++) { ... }

  return { status: 'completed', results: completedResults }
}
```

主循环中的调用方式极为简洁：

```ts
const batchResult = await executeToolBatch(toolCalls, ctx, toolMap, wrappedToolCall, state, signal, turnIndex)

if (batchResult.status === 'suspended') {
  yield batchResult.event
  stopReason = 'suspended'
  break
}

// 正常路径：写入 tool 结果到 state
for (const call of toolCalls) {
  const output = batchResult.results.get(call.id)
  if (output) {
    state.messages.push({ role: 'tool', toolCallId: call.id, content: ... })
  }
}
```

### 5.3 runMainLoop —— 共享主循环引擎

`runLoop` 和 `runLoopFromCheckpoint` 共享同一个主循环 async generator：

```ts
interface MainLoopContext {
  state: AgentState
  startTurnIndex: number
  maxTurns: number
  system: string
  toolDefinitions: ToolDefinition[]
  toolMap: Map<string, Tool>
  pipeline: MiddlewarePipeline
  wrappedToolCall: ToolCallFn
  wrappedModelCall: ModelCallFn
  ctx: RunContext & { turnIndex: number }
  signal: AbortSignal
}

async function* runMainLoop(
  loopCtx: MainLoopContext,
): AsyncGenerator<AgentEvent, { stopReason: RunResult['stopReason']; turnIndex: number }> {
  // while (turnIndex < maxTurns):
  //   1. abort 检查
  //   2. PREPARE（callMessages 快照、beforeModel hooks）
  //   3. MODEL CALL（流式输出）
  //   4. DISPATCH（提取 tool_use）
  //   5. TOOL CALL（executeToolBatch）
  //   6. 写入 tool 结果 → 下一轮
}
```

两个入口函数只需设置不同的 `startTurnIndex`：

- `runLoop` → `startTurnIndex: 0`
- `runLoopFromCheckpoint` → `startTurnIndex: resumeTurnIndex + 1`（处理完 pending calls 后）

### 5.4 initLoopInfra —— 公共初始化

```ts
function initLoopInfra(state: AgentState, config: LoopConfig, externalSignal?: AbortSignal) {
  // 1. AbortController 创建 + 外部信号桥接
  // 2. MiddlewarePipeline 实例化
  // 3. toolMap / toolDefinitions 构建
  // 4. baseToolCall / baseModelCall 定义 + 中间件 wrap
  return { signal, pipeline, toolMap, toolDefinitions, wrappedToolCall, wrappedModelCall, ... }
}
```

### 5.5 runLoop 和 runLoopFromCheckpoint 入口

重构后两者均为薄包装层：

```ts
// runLoop：正常启动
export async function* runLoop(params, config): AsyncGenerator<AgentEvent> {
  const infra = initLoopInfra(state, config, externalSignal)
  // 构建 ctx、生成 runId
  yield { type: 'agent_run_start', ... }
  try {
    await pipeline.runBeforeAgent(ctx)
    const result = yield* runMainLoop({ startTurnIndex: 0, ... })
    stopReason = result.stopReason
  } catch { ... } finally { await pipeline.runAfterAgent(ctx) }
  yield { type: 'agent_run_end', ... }
}

// runLoopFromCheckpoint：从断点恢复
export async function* runLoopFromCheckpoint(params, config): AsyncGenerator<AgentEvent> {
  const state = deserializeAgentState(checkpoint.state)
  const infra = initLoopInfra(state, config, params.signal)
  yield { type: 'agent_run_start', ... }
  try {
    await pipeline.runBeforeAgent(ctx)
    // 阶段 1：处理 pending tool calls（approve / deny / modify）
    for (const call of pendingToolCalls) { ... }
    // 阶段 2：进入正常循环
    const result = yield* runMainLoop({ startTurnIndex: resumeTurnIndex + 1, ... })
    stopReason = result.stopReason
  } catch { ... } finally { await pipeline.runAfterAgent(ctx) }
  yield { type: 'agent_run_end', ... }
}
```

---

## 6. 中间件使用示例

### 6.1 权限审批中间件（触发暂停）

```ts
class PermissionMiddleware extends Middleware {
  name = 'permission'
  store = { approvedTools: [] as string[] }

  async wrapToolCall(next: ToolCallFn, ctx: ToolCallContext) {
    // 已批准的工具直接放行
    if (this.store.approvedTools.includes(ctx.toolName)) {
      return next(ctx)
    }

    // 只读工具自动放行
    const tool = getToolByName(ctx.toolName)
    if (tool?.flags.readonly) {
      return next(ctx)
    }

    // 危险操作：触发暂停，等待人工审批
    throw new SuspendSignal('approval_required', {
      toolName: ctx.toolName,
      toolInput: ctx.toolInput,
      description: `工具 "${ctx.toolName}" 需要人工审批`,
    })
  }
}
```

### 6.2 业务层消费暂停事件

```ts
const state = createAgentState()
state.messages.push({ role: 'user', content: '删除 temp/ 目录下所有文件' })

let checkpoint: SessionCheckpoint | undefined

for await (const event of agent.run({ state })) {
  if (event.type === 'text_delta') {
    process.stdout.write(event.delta)
  }
  if (event.type === 'suspended') {
    checkpoint = event.checkpoint
    console.log(`\n⏸ 暂停: ${event.reason}`)
    console.log('待审批操作:', event.checkpoint.pendingToolCalls)
  }
}

// 暂停后等待用户决策
if (checkpoint) {
  const userChoice = await promptUser('是否批准？(y/n)')

  const decisions: Record<string, ToolCallDecision> = {}
  for (const call of checkpoint.pendingToolCalls) {
    decisions[call.id] =
      userChoice === 'y' ? { action: 'approve' } : { action: 'deny', reason: '用户拒绝' }
  }

  // 恢复执行
  for await (const event of agent.resume({ checkpoint, decisions })) {
    if (event.type === 'text_delta') process.stdout.write(event.delta)
  }
}
```

### 6.3 跨进程恢复场景

```ts
// 进程 A：暂停后持久化 checkpoint
for await (const event of agent.run({ state })) {
  if (event.type === 'suspended') {
    await fs.writeFile('checkpoint.json', JSON.stringify(event.checkpoint))
    process.exit(0) // 进程退出
  }
}

// 进程 B（可能是重启后）：从文件恢复
const checkpoint = JSON.parse(await fs.readFile('checkpoint.json', 'utf-8'))
const decisions = await collectUserDecisions(checkpoint.pendingToolCalls)

for await (const event of agent.resume({ checkpoint, decisions })) {
  // 从断点继续执行
}
```

---

## 7. 并行工具的暂停语义

当模型返回多个 tool_calls 且部分需要审批时：

### 7.1 串行执行的工具

按顺序执行，遇到第一个 SuspendSignal 即暂停，后续工具全部变为 pending：

```
tool_calls: [A, B(需审批), C, D]
执行结果：A 完成 → B 触发 suspend → C, D 成为 pending
pending: [B, C, D]
```

### 7.2 并行安全的工具

并行工具中任何一个触发 SuspendSignal，所有未完成的并行工具都成为 pending：

```
tool_calls: [A(并行), B(并行,需审批), C(串行)]
执行结果：A 和 B 同时开始 → B 触发 suspend
  - 如果 A 先完成了：pending = [B, C]
  - 如果 A 还在跑：取消 A，pending = [A, B, C]
```

**简化策略**：对于存在审批需求的批次，全部改为串行执行，避免"取消正在执行的并行工具"的复杂性。这可以在 Loop 层面实现——检测到 pending calls 中有需要审批的工具时，整批改为串行。

---

## 8. 设计取舍

### 为什么用 SuspendSignal（throw）而不是返回值？

1. **不侵入 ToolOutput 类型**：返回值方案需要扩展 ToolOutput 为联合类型，所有消费方都要处理
2. **短路语义天然**：throw 会立即跳出当前执行栈，不需要在 for 循环中检查返回值
3. **与 AbortSignal 的 abort 机制一致**：都是通过异常通道传递控制信号

### 为什么 checkpoint 中深拷贝 state？

中断后业务层可能继续修改 state（比如查看历史消息、添加用户注释等）。深拷贝确保 checkpoint 是中断瞬间的不可变快照，恢复时不受后续修改影响。

### 为什么恢复时创建新 Loop 而不是"注入结果后重跑"？

如果让业务层自己把 tool 结果注入 state 再调 `agent.run()`，有两个问题：

1. 业务层需要自己执行被中断的工具（Loop 的职责泄露）
2. LLM 看到的是"所有工具都已执行完"，不知道中间有中断过——如果某个工具被 deny 了，error 消息的格式需要和 Loop 内一致

`agent.resume()` 把这些逻辑封装在 Loop 内，业务层只需提供决策。

### 为什么统一 suspend 和 abort 为 interrupt？

从业务层看两者行为一致：

1. 都终止当前 Agent Loop
2. 都可能希望后续恢复执行
3. 恢复时的数据结构和流程完全相同

差异仅在语义层面（reason 字段）：

|                  | SuspendSignal 触发       | AbortSignal 触发（工具阶段） | AbortSignal 触发（流式阶段） |
| ---------------- | ------------------------ | ---------------------------- | ---------------------------- |
| reason           | `'approval_required'` 等 | `'user_abort'`               | —                            |
| 有 pending calls | ✓                        | ✓                            | ✗                            |
| 生成 checkpoint  | ✓                        | ✓                            | ✗                            |
| stopReason       | `'suspended'`            | `'suspended'`                | `'abort'`                    |
| 恢复方式         | `resume()`               | `resume()`                   | 直接 `run()`                 |

### 为什么流式阶段的中断不生成 checkpoint？

模型流式输出期间中断时：

- **state 天然干净**——assistant 消息仅在流完成后才写入 `state.messages`
- **无半截消息**——不完整的 tool_use JSON 无法解析，也无法让 LLM 从断点续写
- **无需决策**——没有 pending tool calls 需要 approve/deny

因此流式中断等价于"丢弃该轮，state 不变"，业务层可追加新的 user message 后直接 `run()`。

### SessionCheckpoint 的序列化要求

- `state.messages`、`state.usage`、`state.store` 都是 JSON 安全的
- 提供 `serializeAgentState()` / `deserializeAgentState()` 辅助函数
