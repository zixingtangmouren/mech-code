# Todo Middleware 设计

## 背景

Todo 功能用于让 Agent 在复杂编码任务中维护一份结构化执行清单。它不是面向用户的任务管理系统，也不是项目文件里的 `TODO.md`，而是 Agent Loop 内部的工作记忆。

当前实现是 `@mech-code/middleware` 中的自包含中间件：

- 中间件：`packages/middleware/src/todo.ts`
- 默认工具名：`write_todos`
- 状态位置：`AgentState.todos`
- CLI 默认挂载：`packages/cli/src/commands/chat.ts`

Todo 中间件负责注册工具、注入使用说明、保存 Todo 状态、控制提醒节奏。上层 UI 通过 Agent 事件流中的 `state_changed` 感知状态变化，不需要 Todo 中间件额外暴露 UI 专用 API。

---

## 设计目标

1. **中间件自包含**：`todoMiddleware()` 一次性提供系统提示、工具、状态初始化和拦截逻辑。
2. **会话级状态**：Todo 保存在 `AgentState` 顶层的 `todos` 字段，随会话状态序列化和恢复，不写入仓库文件。
3. **真实状态修改**：中间件直接修改 `ctx.state` 与 `ctx.state.messages`，不再使用临时消息投影。
4. **全量替换语义**：每次 `write_todos` 提交当前完整清单，避免增量 patch 带来的顺序和合并问题。
5. **轻量约束**：工具 schema 只做基础结构校验；更高层的使用策略通过 system prompt 和中间件提醒完成。

---

## 总体架构

```text
CLI chat
  │
  │ createAgent({ middleware: [todoMiddleware()] })
  │ agent.run({ state, config, props: { cwd, platform, arch } })
  ▼
Agent Loop
  │
  ├─ bindMiddlewareState()
  │    └─ 初始化 AgentState.todos
  │
  ├─ beforeModel(ctx)
  │    └─ 必要时向 ctx.state.messages 注入 Todo reminder
  │
  ├─ wrapModelCall(request, handler)
  │    └─ 追加 Todo system prompt 到 request.params.system
  │
  ├─ Provider 调用
  │    └─ 从 ctx.state.messages 构建请求，发送前移除 _meta
  │
  ├─ afterModel(ctx)
  │    └─ 从 ctx.loopState.lastResponse 统计 write_todos 调用次数
  │
  └─ wrapToolCall(request, handler)
       ├─ 拦截重复 write_todos
       └─ 执行工具并更新 state.todos

External state access
  └─ 监听 state_changed，changedKeys 包含 "todos" 时刷新 UI
```

Todo 中间件依赖 Agent Loop 的分层 Context：`ctx.state` 保存持久会话状态，`ctx.runtime` 保存本次运行能力和可变模型调用配置，`ctx.loopState` 保存当前循环控制状态。

---

## 对外 API

### `todoMiddleware(options)`

```ts
export interface TodoMiddlewareOptions {
  turnsBetweenReminders?: number | false
  turnsSinceWrite?: number | false
  toolResultMode?: 'summary' | 'full'
}
```

| 选项                    | 默认值      | 说明                                                  |
| ----------------------- | ----------- | ----------------------------------------------------- |
| `turnsBetweenReminders` | `10`        | 距离上次注入 reminder 至少经过多少个模型轮次          |
| `turnsSinceWrite`       | `10`        | 距离上次成功使用 `write_todos` 至少经过多少个模型轮次 |
| `toolResultMode`        | `'summary'` | 工具结果返回摘要或完整 JSON                           |

CLI 使用默认配置：

```ts
createAgent({
  provider,
  tools,
  middleware: [todoMiddleware()],
  system,
  maxTurns: 20,
})
```

运行时环境通过 `props` 传入：

```ts
agent.run({
  state,
  config: { signal },
  props: { cwd, platform, arch },
})
```

---

## 工具定义

Todo 中间件内部通过 `defineTool` 注册工具。默认工具名为 `write_todos`。

```ts
const todoItemSchema = z.object({
  content: z.string().min(1, 'Todo content cannot be empty'),
  status: z.enum(['pending', 'in_progress', 'completed']),
})

const writeTodosSchema = z.object({
  todos: z.array(todoItemSchema),
})
```

| 字段      | 类型                                  | 必填 | 说明                                       |
| --------- | ------------------------------------- | ---- | ------------------------------------------ |
| `todos`   | `TodoItem[]`                          | 是   | 当前完整 Todo 列表                         |
| `content` | `string`                              | 是   | 稳定的任务描述，用于模型工作记忆和状态保存 |
| `status`  | `pending \| in_progress \| completed` | 是   | 当前任务状态                               |

Tool flags：

```ts
flags: { readonly: false, parallelSafe: false }
```

- `readonly: false`：工具会修改 `AgentState.todos`。
- `parallelSafe: false`：多个写入并发执行会产生覆盖关系，必须串行。

---

## 状态模型

Todo 状态存放在 `AgentState.todos`，键名由常量导出：

```ts
export const TODO_STORE_KEY = 'todos'
```

当前类型如下：

```ts
export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  content: string
  status: TodoStatus
}

export interface TodoState {
  items: TodoItem[]
  lastWriteTurn?: number
  lastReminderTurn?: number
  turnCounter?: number
  writeCallCountByTurn?: Record<number, number>
}
```

| 字段                   | 说明                                                  |
| ---------------------- | ----------------------------------------------------- |
| `items`                | 最近一次提交的完整 Todo 列表                          |
| `lastWriteTurn`        | 最近一次成功写入发生的 Todo 逻辑轮次                  |
| `lastReminderTurn`     | 最近一次注入 reminder 的 Todo 逻辑轮次                |
| `turnCounter`          | Todo 中间件自己的模型轮次计数器，跨多次 `run()` 保留  |
| `writeCallCountByTurn` | 每个 Agent `loopState.turnIndex` 中模型生成的写入次数 |

工具执行时会复制模型提交的列表，然后覆盖 `state.todos.items`。是否展示、如何过滤已完成项、是否隐藏工具调用，都属于上层 UI 或事件消费方的职责。

---

## 生命周期

### 1. State 初始化

中间件声明默认状态：

```ts
const defaultTodoState: TodoState = {
  items: [],
  writeCallCountByTurn: {},
}
```

Agent Loop 开始时，`bindMiddlewareState()` 会把中间件默认 `state` 合并到 `AgentState` 顶层，且不覆盖调用方已有字段。Todo 中间件同时在 `beforeAgent` 中调用 `ensureTodoState(ctx.state)`，保证 `state.todos` 存在。

### 2. `beforeModel`

每轮模型调用前，Todo 中间件会：

1. 读取当前 Todo 逻辑轮次：`currentTurn = turnCounter ?? 0`
2. 根据未完成项和双阈值决定是否向 `ctx.state.messages` 插入 reminder user message
3. 将 `turnCounter` 加一

### 3. `wrapModelCall`

Todo 工具使用说明属于本次模型请求的真实 system 入参，因此在 `wrapModelCall` 中追加到 `request.params.system`，再调用 `handler(request)`。

这避免了在多轮 loop 中持续修改 `ctx.runtime.system`，导致相同说明被重复追加。

### 4. Reminder 注入

当满足以下条件时，`beforeModel` 会插入 `Todo reminder`：

- `turnsBetweenReminders` 和 `turnsSinceWrite` 均未关闭
- `items` 中存在非 `completed` 项
- 曾经成功写入过 Todo，即 `lastWriteTurn !== undefined`
- `currentTurn - lastWriteTurn >= turnsSinceWrite`
- 如果曾注入过 reminder，则 `currentTurn - lastReminderTurn >= turnsBetweenReminders`

Reminder 不追加到 `ctx.runtime.system`。中间件会在 `ctx.state.messages` 的最后一条真实用户消息之前插入新的 user message，并通过 `_meta` 标记它来自 agent 层注入：

```ts
{
  role: 'user',
  content: 'Todo reminder:\n...',
  _meta: {
    source: 'agent',
    injected: true,
    kind: 'todo_reminder',
  },
}
```

这条注入消息会保留在真实 `state.messages` 和 checkpoint 中。查找“最新真实用户消息”时会跳过 `_meta.injected === true` 的内部消息；Provider 序列化时只发送模型需要的字段，不发送 `_meta`。

### 4. `afterModel`

模型响应后、工具执行前，中间件从 `ctx.loopState.lastResponse.content` 统计本轮 assistant 响应中 `write_todos` 的调用次数，并写入：

```ts
state.writeCallCountByTurn[ctx.loopState.turnIndex] = count
```

这个计数用于后续 `wrapToolCall` 判断同一 assistant turn 是否重复调用 Todo 工具。

### 5. `wrapToolCall`

`wrapToolCall` 只处理 Todo 工具名，其他工具直接放行。

对于 `write_todos`，它会先读取当前 turn 的调用次数。如果次数大于 1，直接返回错误结果，不执行真实工具：

```text
Error: write_todos was called multiple times in the same assistant turn. Submit exactly one complete todo list in the next turn.
```

如果只有一次调用，则执行 `handler(request)`。工具成功且未清空 Todo 状态后更新：

```ts
state.lastWriteTurn = getCurrentTodoTurn(state, request.context.loopState.turnIndex)
```

`getCurrentTodoTurn` 使用 `turnCounter - 1` 取回当前模型调用的 Todo 逻辑轮次，因为 `beforeModel` 已经在调用模型前把 `turnCounter` 自增。

失败时不更新 `lastWriteTurn`。如果本次提交为空列表或所有 Todo 都是 `completed`，工具会清空 `TodoState`，此时不再更新 `lastWriteTurn`。

---

## 工具执行语义

`write_todos` 的执行函数以全量替换为主：

1. 读取 `context.state.todos`
2. 浅拷贝输入 todos
3. 如果输入为空或所有项均为 `completed`，清空 `items`、`lastWriteTurn`、`lastReminderTurn` 与 `writeCallCountByTurn`
4. 否则覆盖 `items`
5. 返回给 LLM 的文本结果
6. 返回附加 metadata

默认 `toolResultMode = 'summary'` 时，返回内容类似：

```text
Todo list updated: 2 pending, 1 in progress, 3 completed.
```

当 `toolResultMode = 'full'` 时，返回内容包含完整 JSON：

```text
Todo list updated: [{"content":"Inspect code","status":"completed"}]
```

工具输出 metadata：

```ts
metadata: {
  type: 'todo',
  todos: submitted,
  cleared: boolean,
}
```

---

## 与 Agent Loop / Checkpoint 的关系

Todo 状态是 `AgentState` 顶层字段的一部分，因此会被：

- `serializeAgentState()` 复制进 checkpoint
- `deserializeAgentState()` 从 checkpoint 恢复
- `Agent.resume()` 继续使用

Todo 中间件本身不触发 HITL，也不需要审批。若 Agent 因其他工具暂停，checkpoint 中会包含当前 `state.todos` 和已注入的内部消息。

外部 UI 不需要监听 `tool_result(write_todos)` 来手动刷新 TodoPanel，而是监听 `state_changed`：

```ts
if (event.type === 'state_changed' && event.changedKeys.includes('todos')) {
  refreshTodoPanel(event.state.todos)
}
```

---

## 当前校验与约束

| 约束                           | 实现位置              | 行为                             |
| ------------------------------ | --------------------- | -------------------------------- |
| `content` 非空                 | Zod schema            | 输入校验失败，工具不执行         |
| `status` 只能是三种枚举        | Zod schema            | 输入校验失败，工具不执行         |
| 同一 assistant turn 只调用一次 | `wrapToolCall`        | 多次调用全部返回错误，不写入状态 |
| Todo 工具串行执行              | `parallelSafe: false` | Agent Loop 将其放入串行工具批次  |

以下策略目前仍由 prompt 建议，不做硬校验：

| 策略                           | 当前状态                                      |
| ------------------------------ | --------------------------------------------- |
| 同一时间最多一个 `in_progress` | 只在 prompt 中要求“Prefer only one”，未强校验 |
| Todo 数量上限                  | 未限制                                        |
| Todo id 唯一                   | 无 `id` 字段                                  |
| 优先级排序                     | 无 `priority` 字段                            |
| revision 递增                  | 无 revision 字段                              |

---

## 测试覆盖

当前 `packages/middleware/src/__tests__/todo.test.ts` 覆盖了以下行为：

1. `todoMiddleware()` 注册 `write_todos` 并初始化 `state.todos`
2. `write_todos` 更新 `items`
3. 全部完成时及时清空 `TodoState`
4. 同一 assistant turn 多次调用 `write_todos` 时返回错误，且不写入状态
5. 只有 `turnsBetweenReminders` 和 `turnsSinceWrite` 同时满足时才注入 `Todo reminder`
6. reminder 作为 agent 注入的 user message 插入到最新真实用户消息前，保留在 `state.messages`，且 `_meta` 不进入 provider payload

建议后续补充：

1. `toolResultMode: 'full'` 的输出格式
2. checkpoint/resume 后 `state.todos` 与注入消息保留
3. CLI 层对 `state_changed(todos)` 的渲染测试

---

## 已知限制与演进方向

### 1. ToolOutput metadata 未进入事件流

`write_todos` 返回了 metadata，但 `tool_result` 事件目前没有携带 metadata。当前 UI 已经通过 `state_changed` 感知 Todo 状态，因此 metadata 不是 TodoPanel 刷新的必要路径。

### 2. 多 `in_progress` 只做软约束

当前 prompt 使用 “Prefer only one in_progress task at a time”，工具层不拒绝多个 `in_progress`。

### 3. 缺少稳定 ID

Todo 项目没有稳定 ID。重排或改写文案时，外部状态消费者难以判断是同一任务的更新还是新任务。

可选演进：增加可选 `id` 字段，或由工具在状态内部派生稳定 key。但这会提高模型调用复杂度，需要权衡。

### 4. Reminder 轮次语义是中间件内部逻辑轮次

`turnCounter` 是 Todo 中间件自己的计数器，会跨多次 `agent.run()` 保留；它不完全等同于 Agent Loop 每次 run 内部从 0 开始的 `loopState.turnIndex`。当前实现只保留 `turnCounter`，在 `beforeModel` 中捕获当前逻辑轮次并传给 reminder，工具写入时用 `turnCounter - 1` 回推当前轮次。

如果后续 AgentState 引入全局 turn 序号，可以用统一的全局 turn 替代这套局部计数。
