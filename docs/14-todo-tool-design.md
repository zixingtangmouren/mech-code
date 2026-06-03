# Todo Tool 设计

## 背景

Todo 功能用于让 Agent 在复杂任务中显式维护待办清单。它不是普通的用户任务管理器，而是面向 Agent Loop 的工作记忆工具：当任务包含多步骤实现、跨文件修改、测试验证或需要持续跟踪进度时，Agent 通过 Todo 将计划、当前执行项和完成状态结构化地暴露出来。

相比仅在 assistant 文本中描述计划，Todo 工具有三个优势：

1. **状态稳定**：待办项保存在运行时 metadata 中，不依赖模型在自然语言上下文中自行回忆。
2. **可观测**：CLI/UI 可以基于结构化事件渲染任务列表，而不是解析 assistant 文本。
3. **行为约束**：工具 schema 可以强制“一次只有一个进行中任务”等不变量，降低计划漂移。

---

## 设计目标

1. **结构化计划**：用统一 schema 表达待办项内容、状态、优先级和顺序。
2. **轻量状态**：Todo 只保存在当前 Agent 会话中，不默认落盘，不污染项目文件。
3. **LLM 友好**：工具输入足够简单，便于模型在每次状态变化时整体更新清单。
4. **UI 友好**：输出 metadata 包含完整 Todo 列表，便于终端或上层应用渲染。
5. **策略外置**：何时必须使用 Todo 由 prompt / 中间件约束，工具自身只做状态校验与写入。

---

## 工具定位

### 与普通文本计划的关系

assistant 文本适合解释思路，Todo 工具适合维护执行状态。复杂任务中推荐流程：

1. 先用 assistant 文本简短说明将要做什么。
2. 调用 `todo_write` 写入初始任务列表。
3. 每完成一个关键步骤后更新状态。
4. 最终所有项变为 `completed`，并在最终回复中概括结果。

### 与项目文件的关系

Todo 工具不创建 `TODO.md`、`README`、设计文档或任务文件。用户明确要求写入项目文档时，应使用 `write_file` / `edit_file`，而不是把 Todo 状态落到仓库。

---

## 参数设计

```typescript
const schema = z.object({
  todos: z
    .array(
      z.object({
        id: z.string().min(1).describe('稳定 ID，同一待办项跨更新保持不变'),
        content: z.string().min(1).describe('待办项内容，使用具体可执行的短句'),
        status: z.enum(['pending', 'in_progress', 'completed']).describe('待办项状态'),
        priority: z.enum(['high', 'medium', 'low']).optional().describe('优先级'),
      }),
    )
    .describe('当前完整 Todo 列表。每次调用都提交全量状态，而不是增量 patch。'),
})
```

### 参数说明

| 字段       | 类型                                  | 必填 | 说明                     |
| ---------- | ------------------------------------- | ---- | ------------------------ |
| `todos`    | `TodoItem[]`                          | 是   | 当前完整 Todo 列表       |
| `id`       | string                                | 是   | 稳定标识，用于 UI diff   |
| `content`  | string                                | 是   | 可执行的任务描述         |
| `status`   | `pending \| in_progress \| completed` | 是   | 当前状态                 |
| `priority` | `high \| medium \| low`               | 否   | 供 UI 排序或强调展示使用 |

### 设计决策：全量更新而不是增量操作

`todo_write` 每次接收完整 Todo 列表，而不是 `add` / `update` / `remove` 这样的增量命令。原因：

- LLM 更容易在一次调用中给出“当前真实状态”，避免增量操作顺序出错。
- Agent Loop 只需要保存最后一次状态，恢复和渲染更简单。
- 删除、重排、合并任务不需要额外 operation 类型。

---

## 状态设计

Todo 状态存放在 `ToolRunContext.metadata` 中，推荐使用内部键名：

```typescript
const TODO_STATE_KEY = '__todoState'

interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  priority?: 'high' | 'medium' | 'low'
}

interface TodoState {
  todos: TodoItem[]
  updatedAt: number
  revision: number
}
```

### 状态生命周期

| 阶段     | 行为                                         |
| -------- | -------------------------------------------- |
| 会话开始 | `metadata['__todoState']` 不存在，视为空列表 |
| 首次写入 | 创建 `TodoState`，`revision = 1`             |
| 后续更新 | 覆盖 todos，`revision += 1`                  |
| 会话恢复 | 随 AgentState metadata 一起恢复              |
| 会话结束 | 不自动写入磁盘                               |

Todo 状态属于会话级状态。它应跟随 `AgentState` 序列化/反序列化，支持 HITL 暂停后继续执行。

---

## 校验规则

### 1. ID 唯一

同一次写入中不允许重复 `id`：

```typescript
const ids = new Set<string>()
for (const todo of input.todos) {
  if (ids.has(todo.id)) {
    return { valid: false, error: `Todo id 重复: ${todo.id}` }
  }
  ids.add(todo.id)
}
```

### 2. 最多一个进行中任务

同一时刻最多允许一个 `in_progress`：

```typescript
const activeCount = input.todos.filter((todo) => todo.status === 'in_progress').length
if (activeCount > 1) {
  return { valid: false, error: '同一时间只能有一个 in_progress Todo' }
}
```

### 3. 内容必须可执行

工具只做基础校验：`content` 非空、去除首尾空白后仍有内容。不在工具层判断内容是否“足够具体”，这类策略通过 prompt 约束。

### 4. 数量上限

为避免 Todo 列表占用过多上下文，建议限制最多 20 项：

```typescript
const MAX_TODOS = 20
if (input.todos.length > MAX_TODOS) {
  return { valid: false, error: `Todo 数量不能超过 ${MAX_TODOS} 项` }
}
```

---

## 输出设计

### ToolOutput

```typescript
interface TodoWriteOutput {
  content: string
  metadata: {
    todos: TodoItem[]
    revision: number
    counts: {
      pending: number
      inProgress: number
      completed: number
    }
  }
}
```

### 返回给 LLM 的内容

`content` 保持简短，只告诉模型状态已经更新：

```text
Todo list updated: 1 in progress, 2 pending, 3 completed.
```

完整列表放在 `metadata.todos`，供 UI 和事件系统使用。这样可以避免把每次完整 Todo 状态重复注入模型上下文。

---

## 执行流程

```
输入校验 (Zod schema)
    ↓
业务校验 (ID 唯一、最多一个 in_progress、数量上限)
    ↓
读取旧 TodoState
    ↓
写入 metadata['__todoState']
    ↓
生成 ToolOutput + metadata
    ↓
Agent Loop 发出 tool_result 事件
```

### execute 示例

```typescript
async execute(input, ctx) {
  const previous = ctx.metadata[TODO_STATE_KEY] as TodoState | undefined
  const revision = (previous?.revision ?? 0) + 1

  const state: TodoState = {
    todos: input.todos,
    updatedAt: Date.now(),
    revision,
  }

  ctx.metadata[TODO_STATE_KEY] = state

  const counts = countTodos(input.todos)

  return {
    content: `Todo list updated: ${counts.inProgress} in progress, ${counts.pending} pending, ${counts.completed} completed.`,
    metadata: {
      todos: input.todos,
      revision,
      counts,
    },
  }
}
```

---

## Tool flags

```typescript
flags: {
  readonly: false,
  parallelSafe: false,
}
```

### 设计说明

- `readonly: false`：Todo 会修改会话 metadata，属于有副作用工具。
- `parallelSafe: false`：并行写入 Todo 会产生最后写入覆盖前一次写入的问题，因此必须串行执行。

---

## Prompt 设计

```typescript
getPrompt(ctx: ToolPromptContext): string {
  return `维护当前任务的 Todo 列表。

使用说明：
- 复杂任务（跨多个文件、需要测试验证、超过 3 个步骤）应使用 todo_write 跟踪进度
- 简单问答、单步命令或用户只要求解释代码时，不需要使用 Todo
- 每次调用都传入完整 Todo 列表，而不是只传变化项
- 同一时间只能有一个任务处于 in_progress
- 开始执行某项前，将其状态设为 in_progress
- 完成某项后，立即将其状态设为 completed，并把下一项设为 in_progress
- content 使用具体动作，不写泛泛的“处理问题”“继续开发”
- 不要用 Todo 替代最终回复；所有任务完成后仍需向用户说明结果`
}
```

### 使用时机

推荐使用 Todo 的场景：

- 用户请求包含多个明确步骤。
- 需要跨模块阅读、修改和验证。
- 需要先实现、再运行测试、再修复问题。
- 用户要求“继续”“完成剩余任务”时，需要恢复上下文。

不推荐使用 Todo 的场景：

- 单个文件的微小修改。
- 纯解释、纯问答、纯代码 review。
- 用户明确要求不要制定计划。

---

## UI 集成

CLI/UI 不应解析 `content` 文本获取 Todo 状态，而应读取 `tool_result` 对应的 `metadata.todos`。

推荐渲染规则：

| 状态          | 展示含义 |
| ------------- | -------- |
| `pending`     | 未开始   |
| `in_progress` | 当前执行 |
| `completed`   | 已完成   |

UI 可以按输入顺序展示 Todo，不需要按 priority 自动重排。priority 只用于视觉强调，避免改变 Agent 明确提交的执行顺序。

---

## 与 Agent Loop / HITL 的关系

Todo 工具本身不触发 HITL，也不需要用户审批。它的副作用只存在于会话 metadata，不影响文件系统或外部命令。

当 Agent 因 HITL 暂停时，Todo 状态应作为 `AgentState.metadata` 的一部分被 checkpoint 保存。恢复后，Agent 可以继续基于最新 Todo 列表推进任务。

---

## 错误处理

| 错误场景           | isError | 处理方式                       |
| ------------------ | ------- | ------------------------------ |
| schema 校验失败    | true    | 返回 Zod 错误摘要              |
| Todo id 重复       | true    | 要求重新提交全量列表           |
| 多个 `in_progress` | true    | 要求保持单一当前任务           |
| Todo 数量超过上限  | true    | 要求合并或删除低价值任务       |
| metadata 写入异常  | true    | 返回内部错误信息，Agent 可重试 |

Todo 校验失败时不应部分写入状态。只有所有校验通过后才覆盖旧的 `TodoState`。

---

## 测试计划

### 单元测试

1. schema 校验：空数组、合法 Todo、非法 status、空 content。
2. ID 唯一：重复 id 返回错误。
3. 单一进行中：多个 `in_progress` 返回错误。
4. revision 递增：连续写入时 revision 从 1 开始递增。
5. metadata 输出：`metadata.todos` 与输入一致，counts 正确。
6. flags：`readonly = false`，`parallelSafe = false`。

### 集成测试

1. Agent 调用 `todo_write` 后，`state.metadata['__todoState']` 被更新。
2. HITL checkpoint / resume 后 Todo 状态保留。
3. CLI 事件聚合器可以从 `tool_result.metadata.todos` 渲染最新列表。

---

## 后续演进

### Phase 1：基础 TodoWrite

- 实现 `todo_write` 工具。
- 保存会话级 TodoState。
- 输出 counts 和完整 metadata。

### Phase 2：UI 原生展示

- CLI 根据 tool_result metadata 渲染 Todo 列表。
- 当前任务变化时减少重复输出，只展示差异或最新列表。

### Phase 3：中间件约束

- 增加 Todo 使用策略中间件。
- 当复杂任务未创建 Todo 时，可在 prompt 或 afterLLMResponse 阶段提醒模型补充。

### Phase 4：状态压缩

- 上下文压缩时保留未完成 Todo。
- 已完成 Todo 可摘要化，避免长期会话中 metadata 过大。
