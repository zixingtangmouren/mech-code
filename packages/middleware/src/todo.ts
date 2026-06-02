import { z } from 'zod'
import { createMiddleware, defineTool } from '@mech-code/core'
import type { AgentMiddleware, RunContext } from '@mech-code/core'

export const TODO_STORE_KEY = 'todos'

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

export interface TodoMiddlewareOptions {
  toolName?: string
  reminderTurns?: number | false
  clearVisibleWhenAllCompleted?: boolean
  toolResultMode?: 'summary' | 'full'
}

interface ResolvedOptions {
  toolName: string
  reminderTurns: number | false
  clearVisibleWhenAllCompleted: boolean
  toolResultMode: 'summary' | 'full'
}

const todoItemSchema = z.object({
  content: z.string().min(1, 'Todo content cannot be empty'),
  status: z.enum(['pending', 'in_progress', 'completed']),
  activeForm: z.string().min(1, 'Todo activeForm cannot be empty').optional(),
})

const writeTodosSchema = z.object({
  todos: z.array(todoItemSchema),
})

const defaultTodoState: TodoState = {
  items: [],
  visibleItems: [],
  writeCallCountByTurn: {},
}

export function todoMiddleware(options: TodoMiddlewareOptions = {}): AgentMiddleware {
  const resolved: ResolvedOptions = {
    toolName: options.toolName ?? 'write_todos',
    reminderTurns: options.reminderTurns ?? 3,
    clearVisibleWhenAllCompleted: options.clearVisibleWhenAllCompleted ?? true,
    toolResultMode: options.toolResultMode ?? 'summary',
  }

  const writeTodosTool = defineTool({
    name: resolved.toolName,
    description:
      'Replace the current todo list for complex multi-step work. Use it to track pending, in-progress, and completed tasks.',
    schema: writeTodosSchema,
    flags: { readonly: false, parallelSafe: false },
    execute(input, context) {
      const state = ensureTodoState(context.store)
      const submitted = input.todos.map((todo) => ({ ...todo }))
      const allCompleted =
        submitted.length > 0 && submitted.every((todo) => todo.status === 'completed')

      state.items = submitted
      state.visibleItems =
        resolved.clearVisibleWhenAllCompleted && allCompleted
          ? []
          : submitted.map((todo) => ({ ...todo }))

      return {
        content:
          resolved.toolResultMode === 'full'
            ? `Todo list updated: ${JSON.stringify(submitted)}`
            : summarizeTodos(submitted),
        metadata: {
          type: 'todo',
          todos: submitted,
          visibleTodos: state.visibleItems,
        },
      }
    },
  })

  return createMiddleware({
    name: 'todo',
    store: { [TODO_STORE_KEY]: defaultTodoState },
    tools: [writeTodosTool],
    beforeAgent(ctx) {
      ensureTodoState(ctx.state.store)
    },
    beforeModel(ctx) {
      const state = ensureTodoState(ctx.state.store)
      const activeTurn = state.turnCounter ?? 0
      state.activeTurn = activeTurn
      ctx.system = appendSystemSection(ctx.system, buildTodoInstructions(resolved.toolName))

      const reminder = buildReminder(ctx, resolved)
      if (reminder) {
        ctx.system = appendSystemSection(ctx.system, reminder)
      }
      state.turnCounter = activeTurn + 1
    },
    afterModel(ctx) {
      const state = ensureTodoState(ctx.state.store)
      const count = countToolCalls(ctx, resolved.toolName)
      if (count > 0) {
        state.writeCallCountByTurn ??= {}
        state.writeCallCountByTurn[ctx.turnIndex] = count
      }
    },
    async wrapToolCall(next, ctx) {
      if (ctx.toolName !== resolved.toolName) {
        return next(ctx)
      }

      const state = ensureTodoState(ctx.state.store)
      const count =
        state.writeCallCountByTurn?.[ctx.turnIndex] ??
        countLatestAssistantToolCalls(ctx.state.messages, resolved.toolName)
      if (count > 1) {
        return {
          content:
            `Error: ${resolved.toolName} was called multiple times in the same assistant turn. ` +
            'Submit exactly one complete todo list in the next turn.',
          isError: true,
        }
      }

      const output = await next(ctx)
      if (!output.isError) {
        state.lastWriteTurn = state.activeTurn ?? state.turnCounter ?? ctx.turnIndex
      }
      return output
    },
  })
}

export function getTodoState(store: Record<string, unknown>): TodoState {
  return ensureTodoState(store)
}

function ensureTodoState(store: Record<string, unknown>): TodoState {
  const existing = store[TODO_STORE_KEY]
  if (isTodoState(existing)) return existing

  const created = structuredClone(defaultTodoState)
  store[TODO_STORE_KEY] = created
  return created
}

function isTodoState(value: unknown): value is TodoState {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return Array.isArray(record.items) && Array.isArray(record.visibleItems)
}

function countToolCalls(ctx: RunContext, toolName: string): number {
  const content = ctx.lastResponse?.content
  if (!Array.isArray(content)) return 0
  return content.filter((block) => block.type === 'tool_use' && block.name === toolName).length
}

function countLatestAssistantToolCalls(
  messages: RunContext['state']['messages'],
  toolName: string,
): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue
    const calls = message.content.filter(
      (block) => block.type === 'tool_use' && block.name === toolName,
    )
    return calls.length
  }
  return 0
}

function buildTodoInstructions(toolName: string): string {
  return [
    'Todo tracking:',
    `- Use ${toolName} for complex multi-step tasks, not for trivial one-step requests.`,
    '- Keep the list current as work progresses.',
    '- Mark a task in_progress before working on it.',
    '- Mark completed only after the task is actually finished.',
    '- Prefer only one in_progress task at a time.',
    `- Do not call ${toolName} more than once in a single assistant turn.`,
  ].join('\n')
}

function buildReminder(ctx: RunContext, options: ResolvedOptions): string | null {
  if (options.reminderTurns === false) return null

  const state = ensureTodoState(ctx.state.store)
  const visible = state.visibleItems.filter((todo) => todo.status !== 'completed')
  if (visible.length === 0) return null

  const lastWriteTurn = state.lastWriteTurn
  const activeTurn = state.activeTurn ?? 0
  if (lastWriteTurn === undefined) return null
  if (activeTurn - lastWriteTurn < options.reminderTurns) return null
  if (
    state.lastReminderTurn !== undefined &&
    activeTurn - state.lastReminderTurn < options.reminderTurns
  ) {
    return null
  }

  state.lastReminderTurn = activeTurn
  return [
    'Todo reminder:',
    'Current unfinished todos:',
    ...visible.map(
      (todo) =>
        `- [${todo.status}] ${
          todo.activeForm && todo.status === 'in_progress' ? todo.activeForm : todo.content
        }`,
    ),
    `Update the list with ${options.toolName} when progress changes.`,
  ].join('\n')
}

function appendSystemSection(system: string, section: string): string {
  return system ? `${system}\n\n${section}` : section
}

function summarizeTodos(todos: TodoItem[]): string {
  const pending = todos.filter((todo) => todo.status === 'pending').length
  const inProgress = todos.filter((todo) => todo.status === 'in_progress').length
  const completed = todos.filter((todo) => todo.status === 'completed').length
  return `Todo list updated: ${pending} pending, ${inProgress} in progress, ${completed} completed.`
}
