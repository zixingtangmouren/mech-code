# Todo Middleware 设计

## 背景

Todo 功能用于让 Agent 在复杂编码任务中维护一份结构化的执行清单。它不是面向用户的任务管理系统，也不是项目文件里的 `TODO.md`，而是 Agent Loop 内部的工作记忆。

当前实现已经不是独立的 `todo_write` 工具，而是 `@mech-code/middleware` 中的一个自包含中间件：

- 中间件：`packages/middleware/src/todo.ts`
- 默认工具名：`write_todos`
- 状态位置：`AgentState.store.todos`
- CLI 默认挂载：`packages/cli/src/commands/chat.ts`

Todo 中间件的职责是：注册工具、注入使用说明、保存 Todo 状态、控制提醒节奏。它属于 core/middleware 能力层，不设计任何上层 UI 展示参数或读取入口。

---

## 设计目标

1. **中间件自包含**：Todo 能力由 `todoMiddleware()` 一次性提供，不要求调用方额外注册独立工具。
2. **会话级状态**：Todo 保存在 `AgentState.store`，随会话状态序列化和恢复，不写入仓库文件。
3. **全量替换语义**：每次 `write_todos` 提交当前完整清单，避免增量 patch 带来的顺序和合并问题。
4. **core-only 状态**：中间件只维护内部事实状态，不提供 UI 专用字段、展示文案或渲染策略。
5. **轻量约束**：工具 schema 只做基础结构校验；更高层的使用策略通过 system prompt 和中间件提醒完成。

---

## 总体架构

```
CLI chat
  │
  │ createAgent({ middleware: [todoMiddleware()] })
  ▼
Agent Loop
  │
  ├─ bindMiddlewareStores()
  │    └─ 初始化 AgentState.store.todos
  │
  ├─ beforeModel()
  │    ├─ 注入 LangChain 同款 Todo system prompt
  │    └─ 必要时注入 Todo reminder
  │
  ├─ LLM 调用
  │    └─ 可能产生 write_todos tool_use
  │
  ├─ afterModel()
  │    └─ 记录本轮 write_todos 调用次数
  │
  └─ wrapToolCall()
       ├─ 拦截重复 write_todos
       └─ 执行工具并更新 store.todos

External state access
  └─ 由后续统一状态读取机制提供，不由 Todo 中间件单独暴露
```

Todo 中间件依赖 `docs/13-middleware-pro-design.md` 描述的“中间件工具注册 + store 共享状态”能力：中间件通过 `tools` 字段注册 `write_todos`，框架在 Agent 初始化时把它和普通工具合并到同一个 `toolMap`。

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

CLI 目前使用默认配置：

```ts
createAgent({
  provider,
  tools,
  middleware: [todoMiddleware()],
  system,
  cwd,
  maxTurns: 20,
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

### 字段说明

| 字段      | 类型                                  | 必填 | 说明                                       |
| --------- | ------------------------------------- | ---- | ------------------------------------------ |
| `todos`   | `TodoItem[]`                          | 是   | 当前完整 Todo 列表                         |
| `content` | `string`                              | 是   | 稳定的任务描述，用于模型工作记忆和状态保存 |
| `status`  | `pending \| in_progress \| completed` | 是   | 当前任务状态                               |

当前 schema 不包含旧文档中的 `id`、`priority`、`revision` 字段，也不限制 Todo 数量。

### Tool flags

```ts
flags: { readonly: false, parallelSafe: false }
```

- `readonly: false`：工具会修改 `AgentState.store.todos`。
- `parallelSafe: false`：多个写入并发执行会产生覆盖关系，必须串行。

---

## 状态模型

Todo 状态存放在 `AgentState.store.todos`，键名由常量导出：

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

### 字段语义

| 字段                   | 说明                                                   |
| ---------------------- | ------------------------------------------------------ |
| `items`                | 最近一次提交的完整 Todo 列表                           |
| `lastWriteTurn`        | 最近一次成功写入发生的 Todo 逻辑轮次                   |
| `lastReminderTurn`     | 最近一次注入 reminder 的 Todo 逻辑轮次                 |
| `turnCounter`          | Todo 中间件自己的模型轮次计数器，跨多次 `run()` 保留   |
| `writeCallCountByTurn` | 每个 Agent `turnIndex` 中模型生成的 `write_todos` 次数 |

### `items`

`items` 保存完整事实。工具执行时会复制模型提交的列表：

```ts
const submitted = input.todos.map((todo) => ({ ...todo }))
```

然后覆盖 `state.items`。是否展示、如何过滤已完成项、是否隐藏工具调用，都属于上层 UI 或事件消费方的职责，不属于 Todo 中间件状态模型。

---

## 生命周期

### 1. Store 绑定

中间件声明默认状态：

```ts
const defaultTodoState: TodoState = {
  items: [],
  writeCallCountByTurn: {},
}
```

Agent Loop 开始时，`bindMiddlewareStores()` 会把中间件默认 `store` 合并到 `AgentState.store`，并把中间件的 `store` 指向同一个共享对象。Todo 中间件同时在 `beforeAgent` 中调用 `ensureTodoState(ctx.state.store)`，保证状态存在。

### 2. `beforeModel`

每轮模型调用前，Todo 中间件会：

1. 读取当前 Todo 逻辑轮次：`currentTurn = turnCounter ?? 0`
2. 追加 LangChain `TODO_LIST_MIDDLEWARE_SYSTEM_PROMPT` 到 `ctx.system`
3. 根据未完成项和双阈值决定是否插入 reminder user message
4. 将 `turnCounter` 加一

注入的基础说明直接复刻 LangChain `todoListMiddleware.ts`：

```text
## `write_todos`

You have access to the `write_todos` tool to help you manage and plan complex objectives.
...
```

### 3. Reminder 注入

当满足以下条件时，`beforeModel` 会插入 `Todo reminder`：

- `turnsBetweenReminders` 和 `turnsSinceWrite` 均未关闭
- `items` 中存在非 `completed` 项
- 曾经成功写入过 Todo，即 `lastWriteTurn !== undefined`
- `currentTurn - lastWriteTurn >= turnsSinceWrite`
- 如果曾注入过 reminder，则 `currentTurn - lastReminderTurn >= turnsBetweenReminders`

提醒只列出未完成项：

```text
Todo reminder:
Current unfinished todos:
- [pending] Inspect code
- [in_progress] Running tests
Update the list with write_todos when progress changes.
```

Reminder 不追加到 `ctx.system`。中间件会在 `ctx.callMessages` 的最后一条用户消息之前插入一条新的 user message，并通过 `_meta` 标记它来自 agent 层注入：

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

`ctx.callMessages` 是本轮模型调用投影，不写回 `state.messages`；发送给 Provider 前的 normalize 只保留 `role/content`，不会把 `_meta` 发给模型 API。

### 4. `afterModel`

模型响应后、工具执行前，中间件从 `ctx.lastResponse.content` 里统计本轮 assistant 响应中 `write_todos` 的调用次数，并写入：

```ts
state.writeCallCountByTurn[ctx.turnIndex] = count
```

这个计数用于后续 `wrapToolCall` 判断同一 assistant turn 是否重复调用 Todo 工具。

### 5. `wrapToolCall`

`wrapToolCall` 只处理 Todo 工具名，其他工具直接放行。

对于 `write_todos`，它会先读取当前 turn 的调用次数。如果次数大于 1，直接返回错误结果，不执行真实工具：

```text
Error: write_todos was called multiple times in the same assistant turn. Submit exactly one complete todo list in the next turn.
```

如果只有一次调用，则执行 `next(ctx)`。工具成功且未清空 Todo 状态后更新：

```ts
state.lastWriteTurn = getCurrentTodoTurn(state, ctx.turnIndex)
```

`getCurrentTodoTurn` 使用 `turnCounter - 1` 取回当前模型调用的 Todo 逻辑轮次，因为 `beforeModel` 已经在调用模型前把 `turnCounter` 自增。这样不需要额外保存 `activeTurn`。

失败时不更新 `lastWriteTurn`。如果本次提交为空列表或所有 Todo 都是 `completed`，工具会清空 `TodoState`，此时不再更新 `lastWriteTurn`。

---

## 工具执行语义

`write_todos` 的执行函数以全量替换为主：

1. 读取 `context.store.todos`
2. 浅拷贝输入 todos
3. 如果输入为空或所有项均为 `completed`，清空 `state.items`、`lastWriteTurn`、`lastReminderTurn` 与 `writeCallCountByTurn`
4. 否则覆盖 `state.items`
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

Todo 状态是 `AgentState.store` 的一部分，因此会被：

- `serializeAgentState()` 复制进 checkpoint
- `deserializeAgentState()` 从 checkpoint 恢复
- `Agent.resume()` 继续使用

Todo 中间件本身不触发 HITL，也不需要审批。若 Agent 因其他工具暂停，checkpoint 中会包含当前 `store.todos`。

---

## 当前校验与约束

### 已实现

| 约束                           | 实现位置              | 行为                             |
| ------------------------------ | --------------------- | -------------------------------- |
| `content` 非空                 | Zod schema            | 输入校验失败，工具不执行         |
| `status` 只能是三种枚举        | Zod schema            | 输入校验失败，工具不执行         |
| 同一 assistant turn 只调用一次 | `wrapToolCall`        | 多次调用全部返回错误，不写入状态 |
| Todo 工具串行执行              | `parallelSafe: false` | Agent Loop 将其放入串行工具批次  |

### 未实现但由 prompt 建议

| 策略                           | 当前状态                                      |
| ------------------------------ | --------------------------------------------- |
| 同一时间最多一个 `in_progress` | 只在 prompt 中要求“Prefer only one”，未强校验 |
| Todo 数量上限                  | 未限制                                        |
| Todo id 唯一                   | 无 `id` 字段                                  |
| 优先级排序                     | 无 `priority` 字段                            |
| revision 递增                  | 无 revision 字段                              |

这些策略如果要变成硬约束，应在 `defineTool({ validateInput })` 里追加业务校验，而不是只依赖 prompt。

---

## 测试覆盖

当前 `packages/middleware/src/__tests__/todo.test.ts` 覆盖了以下行为：

1. `todoMiddleware()` 注册 `write_todos` 并初始化 `store.todos`
2. `write_todos` 更新 `items`
3. 全部完成时及时清空 `TodoState`
4. 同一 assistant turn 多次调用 `write_todos` 时返回错误，且不写入状态
5. 只有 `turnsBetweenReminders` 和 `turnsSinceWrite` 同时满足时才注入 `Todo reminder`
6. reminder 作为 agent 注入的 user message 插入到最新用户消息前，且不污染 `state.messages`

建议后续补充：

1. `toolResultMode: 'full'` 的输出格式
2. checkpoint/resume 后 `store.todos` 保留
3. 通过后续统一状态读取机制暴露 Todo 状态

---

## 已知限制与演进方向

### 1. ToolOutput metadata 未进入事件流

`write_todos` 返回了 metadata，但 `tool_result` 事件目前没有携带 metadata。

可选演进：扩展 `AgentEvent.tool_result`，加入可选 `metadata` 字段，使调用方可以从事件流观察结构化状态变化。

### 2. 多 `in_progress` 只做软约束

当前 prompt 使用 “Prefer only one in_progress task at a time”，工具层不拒绝多个 `in_progress`。

可选演进：如果行为策略需要严格保证单一当前任务，可在 `validateInput` 中增加硬约束。

### 3. 缺少稳定 ID

Todo 项目没有稳定 ID。重排或改写文案时，外部状态消费者难以判断是同一任务的更新还是新任务。

可选演进：增加可选 `id` 字段，或由工具在 store 内部派生稳定 key。但这会提高模型调用复杂度，需要权衡。

### 4. Reminder 轮次语义是中间件内部逻辑轮次

`turnCounter` 是 Todo 中间件自己的计数器，会跨多次 `agent.run()` 保留；它不完全等同于 Agent Loop 每次 run 内部从 0 开始的 `turnIndex`。当前实现只保留 `turnCounter`，在 `beforeModel` 中捕获当前逻辑轮次并传给 reminder，工具写入时用 `turnCounter - 1` 回推当前轮次。

如果后续 AgentState 引入全局 turn 序号，可以用统一的全局 turn 替代这套局部计数。
