# Todo Middleware 设计

## 背景

Todo 功能用于让 Agent 在复杂编码任务中维护一份结构化的执行清单。它不是面向用户的任务管理系统，也不是项目文件里的 `TODO.md`，而是 Agent Loop 内部的工作记忆和 UI 展示状态。

当前实现已经不是独立的 `todo_write` 工具，而是 `@mech-code/middleware` 中的一个自包含中间件：

- 中间件：`packages/middleware/src/todo.ts`
- 默认工具名：`write_todos`
- 状态位置：`AgentState.store.todos`
- CLI 面板：`packages/cli/src/ui/components/TodoPanel.tsx`
- CLI 默认挂载：`packages/cli/src/commands/chat.ts`

Todo 中间件的职责是：注册工具、注入使用说明、保存 Todo 状态、控制提醒节奏，并为 CLI 暴露可渲染的未完成项。

---

## 设计目标

1. **中间件自包含**：Todo 能力由 `todoMiddleware()` 一次性提供，不要求调用方额外注册独立工具。
2. **会话级状态**：Todo 保存在 `AgentState.store`，随会话状态序列化和恢复，不写入仓库文件。
3. **全量替换语义**：每次 `write_todos` 提交当前完整清单，避免增量 patch 带来的顺序和合并问题。
4. **低噪声 UI**：CLI 隐藏 `write_todos` 工具调用，只通过 Todo 面板展示当前未完成事项。
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
  │    ├─ 注入 Todo tracking 说明
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

CLI Session
  └─ getTodoState(state.store).visibleItems → TodoPanel
```

Todo 中间件依赖 `docs/13-middleware-pro-design.md` 描述的“中间件工具注册 + store 共享状态”能力：中间件通过 `tools` 字段注册 `write_todos`，框架在 Agent 初始化时把它和普通工具合并到同一个 `toolMap`。

---

## 对外 API

### `todoMiddleware(options)`

```ts
export interface TodoMiddlewareOptions {
  toolName?: string
  reminderTurns?: number | false
  clearVisibleWhenAllCompleted?: boolean
  toolResultMode?: 'summary' | 'full'
}
```

| 选项                           | 默认值          | 说明                                             |
| ------------------------------ | --------------- | ------------------------------------------------ |
| `toolName`                     | `'write_todos'` | 注册给 LLM 的工具名                              |
| `reminderTurns`                | `3`             | 距离上次写入多少个模型轮次后提醒；`false` 为关闭 |
| `clearVisibleWhenAllCompleted` | `true`          | 全部完成后是否清空 UI 可见清单                   |
| `toolResultMode`               | `'summary'`     | 工具结果返回摘要或完整 JSON                      |

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

### `getTodoState(store)`

```ts
export function getTodoState(store: Record<string, unknown>): TodoState
```

`getTodoState` 是 UI 和外部调用方读取 Todo 状态的入口。它会调用内部的 `ensureTodoState`，当 `store.todos` 不存在或形状不符合预期时，自动创建默认状态。

---

## 工具定义

Todo 中间件内部通过 `defineTool` 注册工具。默认工具名为 `write_todos`。

```ts
const todoItemSchema = z.object({
  content: z.string().min(1, 'Todo content cannot be empty'),
  status: z.enum(['pending', 'in_progress', 'completed']),
  activeForm: z.string().min(1, 'Todo activeForm cannot be empty').optional(),
})

const writeTodosSchema = z.object({
  todos: z.array(todoItemSchema),
})
```

### 字段说明

| 字段         | 类型                                  | 必填 | 说明                                         |
| ------------ | ------------------------------------- | ---- | -------------------------------------------- |
| `todos`      | `TodoItem[]`                          | 是   | 当前完整 Todo 列表                           |
| `content`    | `string`                              | 是   | 稳定的任务描述，用于普通展示和长期状态保存   |
| `status`     | `pending \| in_progress \| completed` | 是   | 当前任务状态                                 |
| `activeForm` | `string`                              | 否   | 当前进行中任务的动作式文案，用于 UI/提醒展示 |

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
  activeForm?: string
}

export interface TodoState {
  items: TodoItem[]
  visibleItems: TodoItem[]
  lastWriteTurn?: number
  lastReminderTurn?: number
  turnCounter?: number
  activeTurn?: number
  writeCallCountByTurn?: Record<number, number>
}
```

### 字段语义

| 字段                   | 说明                                                   |
| ---------------------- | ------------------------------------------------------ |
| `items`                | 最近一次提交的完整 Todo 列表                           |
| `visibleItems`         | 当前应该展示给 UI 的列表                               |
| `lastWriteTurn`        | 最近一次成功写入发生的 Todo 逻辑轮次                   |
| `lastReminderTurn`     | 最近一次注入 reminder 的 Todo 逻辑轮次                 |
| `turnCounter`          | Todo 中间件自己的模型轮次计数器，跨多次 `run()` 保留   |
| `activeTurn`           | 当前 `beforeModel` 阶段捕获的逻辑轮次                  |
| `writeCallCountByTurn` | 每个 Agent `turnIndex` 中模型生成的 `write_todos` 次数 |

### `items` 与 `visibleItems`

`items` 保存完整事实，`visibleItems` 服务 UI 展示。工具执行时会先复制模型提交的列表：

```ts
const submitted = input.todos.map((todo) => ({ ...todo }))
```

然后按配置更新：

- 如果 `clearVisibleWhenAllCompleted = true`
- 且列表非空
- 且所有项都是 `completed`

则 `visibleItems = []`，CLI 面板消失；否则 `visibleItems` 是提交列表的浅拷贝。

这使最终状态仍然可通过 `items` 查询，同时避免任务完成后 CLI 持续显示已完成清单。

---

## 生命周期

### 1. Store 绑定

中间件声明默认状态：

```ts
const defaultTodoState: TodoState = {
  items: [],
  visibleItems: [],
  writeCallCountByTurn: {},
}
```

Agent Loop 开始时，`bindMiddlewareStores()` 会把中间件默认 `store` 合并到 `AgentState.store`，并把中间件的 `store` 指向同一个共享对象。Todo 中间件同时在 `beforeAgent` 中调用 `ensureTodoState(ctx.state.store)`，保证状态存在。

### 2. `beforeModel`

每轮模型调用前，Todo 中间件会：

1. 读取并设置 `activeTurn = turnCounter ?? 0`
2. 追加 Todo 使用说明到 `ctx.system`
3. 根据未完成项和提醒阈值决定是否追加 reminder
4. 将 `turnCounter` 加一

注入的基础说明包括：

```text
Todo tracking:
- Use write_todos for complex multi-step tasks, not for trivial one-step requests.
- Keep the list current as work progresses.
- Mark a task in_progress before working on it.
- Mark completed only after the task is actually finished.
- Prefer only one in_progress task at a time.
- Do not call write_todos more than once in a single assistant turn.
```

### 3. Reminder 注入

当满足以下条件时，`beforeModel` 会追加 `Todo reminder`：

- `reminderTurns` 未关闭
- `visibleItems` 中存在非 `completed` 项
- 曾经成功写入过 Todo，即 `lastWriteTurn !== undefined`
- `activeTurn - lastWriteTurn >= reminderTurns`
- 距离上次 reminder 也至少经过 `reminderTurns`

提醒只列出未完成项：

```text
Todo reminder:
Current unfinished todos:
- [pending] Inspect code
- [in_progress] Running tests
Update the list with write_todos when progress changes.
```

对于 `in_progress` 项，如果存在 `activeForm`，提醒和 UI 都优先展示 `activeForm`。

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

如果只有一次调用，则执行 `next(ctx)`。工具成功后更新：

```ts
state.lastWriteTurn = state.activeTurn ?? state.turnCounter ?? ctx.turnIndex
```

失败时不更新 `lastWriteTurn`。

---

## 工具执行语义

`write_todos` 的执行函数只做全量替换：

1. 读取 `context.store.todos`
2. 浅拷贝输入 todos
3. 覆盖 `state.items`
4. 根据完成状态和配置计算 `state.visibleItems`
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
  visibleTodos: state.visibleItems,
}
```

注意：当前 Agent Loop 的 `tool_result` 事件只向外暴露 `output.content` 和 `isError`，没有把 `ToolOutput.metadata` 放入事件。因此 CLI 的 Todo 面板不是从事件 metadata 渲染，而是直接读取共享的 `AgentState.store.todos.visibleItems`。

---

## CLI 集成

### 默认启用

`chat` 命令创建 Agent 时默认挂载 `todoMiddleware()`。这意味着交互式 CLI 中，模型默认可以调用 `write_todos`。

### 隐藏工具调用

CLI 事件聚合器和 spinner 逻辑会特殊处理 `write_todos`：

- `useEventAggregator` 忽略 `write_todos` 的 `tool_start`、`tool_executing`、`tool_result`
- `Session` 不把 `write_todos` 当成普通工具执行状态展示
- 收到 `write_todos` 的 `tool_result` 后，`todoRevision` 加一以触发面板刷新

这样用户不会看到一条普通工具调用记录，而是看到一个独立的 Todo 面板。

### TodoPanel 渲染

`TodoPanel` 接收 `visibleItems`，并再次过滤掉 `completed`：

```ts
const visible = todos.filter((todo) => todo.status !== 'completed')
```

渲染规则：

| 状态          | 图标   | 颜色             | 文案来源                          |
| ------------- | ------ | ---------------- | --------------------------------- |
| `in_progress` | `→`    | `colors.warning` | 优先 `activeForm`，否则 `content` |
| `pending`     | `•`    | `colors.muted`   | `content`                         |
| `completed`   | 不显示 | 不显示           | 已被过滤                          |

当没有可见未完成项时，`TodoPanel` 返回 `null`。

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
| `activeForm` 非空              | Zod schema            | 输入校验失败，工具不执行         |
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
2. `write_todos` 更新 `items` 与 `visibleItems`
3. 全部完成时清空 `visibleItems`
4. 同一 assistant turn 多次调用 `write_todos` 时返回错误，且不写入状态
5. 达到 `reminderTurns` 阈值后注入 `Todo reminder`

建议后续补充：

1. `activeForm` 在 reminder 和 UI 展示中的优先级
2. `toolResultMode: 'full'` 的输出格式
3. `clearVisibleWhenAllCompleted: false` 时保留 `visibleItems`
4. 自定义 `toolName` 时 CLI 是否也需要同步隐藏和刷新逻辑
5. checkpoint/resume 后 `store.todos` 保留

---

## 已知限制与演进方向

### 1. CLI 对工具名硬编码

CLI 当前多处硬编码 `write_todos`。如果业务方传入 `todoMiddleware({ toolName: '...' })`，核心中间件可以正常注册工具，但 CLI 不会自动隐藏新工具名，也不会在工具结果后刷新面板。

可选演进：导出默认工具名常量，或让 CLI 从中间件状态/metadata 判断 Todo 工具结果。

### 2. ToolOutput metadata 未进入事件流

`write_todos` 返回了 metadata，但 `tool_result` 事件目前没有携带 metadata。UI 因此只能读取共享 `AgentState.store`。

可选演进：扩展 `AgentEvent.tool_result`，加入可选 `metadata` 字段，使非 CLI 调用方也能只靠事件流渲染 Todo。

### 3. 多 `in_progress` 只做软约束

当前 prompt 使用 “Prefer only one in_progress task at a time”，工具层不拒绝多个 `in_progress`。

可选演进：如果 UI 和行为策略需要严格保证单一当前任务，可在 `validateInput` 中增加硬约束。

### 4. 缺少稳定 ID

Todo 项目前以 `content + status + index` 作为 React key 的一部分，没有稳定 ID。重排或改写文案时，UI diff 能力有限。

可选演进：增加可选 `id` 字段，或由工具在 store 内部派生稳定 key。但这会提高模型调用复杂度，需要权衡。

### 5. Reminder 轮次语义是中间件内部逻辑轮次

`turnCounter` 是 Todo 中间件自己的计数器，会跨多次 `agent.run()` 保留；它不完全等同于 Agent Loop 每次 run 内部从 0 开始的 `turnIndex`。当前实现通过 `activeTurn` 把两者桥接，用于跨用户输入后的提醒节奏。

如果后续 AgentState 引入全局 turn 序号，可以用统一的全局 turn 替代这套局部计数。
