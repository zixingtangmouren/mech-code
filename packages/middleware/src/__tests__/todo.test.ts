import { describe, expect, it, vi } from 'vitest'
import { createAgent, createAgentState } from '@mech-code/core'
import type {
  CallOptions,
  ChatParams,
  ChatResponse,
  LLMProvider,
  StreamResult,
} from '@mech-code/core'
import { getTodoState, todoMiddleware } from '../todo.js'

interface MockProvider extends LLMProvider {
  streamMock: ReturnType<typeof vi.fn<(params: ChatParams, options?: CallOptions) => StreamResult>>
  streamCalls: ChatParams[]
}

function createProvider(finals: ChatResponse[]): MockProvider {
  let index = 0
  const streamCalls: ChatParams[] = []
  const streamMock = vi.fn((params: ChatParams, _options?: CallOptions): StreamResult => {
    streamCalls.push(params)
    return {
      stream: (async function* () {})(),
      final: Promise.resolve(finals[index++]!),
      abort: vi.fn(),
    }
  })

  return {
    name: 'mock',
    chat: vi.fn(),
    stream: streamMock,
    streamMock,
    streamCalls,
  }
}

describe('todoMiddleware', () => {
  it('registers write_todos and initializes todo state', async () => {
    const provider = createProvider([
      {
        content: [{ type: 'text', text: 'ok' }],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'end_turn',
      },
    ])
    const state = createAgentState()
    const agent = createAgent({ provider, middleware: [todoMiddleware()] })

    for await (const _event of agent.run({ state })) {
      // consume stream
    }

    expect(getTodoState(state.store)).toMatchObject({ items: [], visibleItems: [] })
    expect(provider.streamMock).toHaveBeenCalled()
    expect(provider.streamCalls[0]?.tools?.some((tool) => tool.name === 'write_todos')).toBe(true)
  })

  it('updates items and visibleItems from write_todos', async () => {
    const provider = createProvider([
      {
        content: [
          {
            type: 'tool_use',
            id: 'todo-1',
            name: 'write_todos',
            input: {
              todos: [
                { content: 'Inspect code', status: 'completed' },
                {
                  content: 'Implement middleware',
                  status: 'in_progress',
                  activeForm: 'Implementing middleware',
                },
              ],
            },
          },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'done' }],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'end_turn',
      },
    ])
    const state = createAgentState()
    const agent = createAgent({ provider, middleware: [todoMiddleware()], maxTurns: 3 })

    for await (const _event of agent.run({ state })) {
      // consume stream
    }

    const todos = getTodoState(state.store)
    expect(todos.items).toHaveLength(2)
    expect(todos.visibleItems).toHaveLength(2)
    expect(todos.lastWriteTurn).toBe(0)
  })

  it('clears visibleItems when all todos are completed', async () => {
    const provider = createProvider([
      {
        content: [
          {
            type: 'tool_use',
            id: 'todo-1',
            name: 'write_todos',
            input: { todos: [{ content: 'Verify', status: 'completed' }] },
          },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'done' }],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'end_turn',
      },
    ])
    const state = createAgentState()
    const agent = createAgent({ provider, middleware: [todoMiddleware()], maxTurns: 3 })

    for await (const _event of agent.run({ state })) {
      // consume stream
    }

    const todos = getTodoState(state.store)
    expect(todos.items).toEqual([{ content: 'Verify', status: 'completed' }])
    expect(todos.visibleItems).toEqual([])
  })

  it('rejects multiple write_todos calls in one assistant turn', async () => {
    const provider = createProvider([
      {
        content: [
          {
            type: 'tool_use',
            id: 'todo-1',
            name: 'write_todos',
            input: { todos: [{ content: 'First', status: 'pending' }] },
          },
          {
            type: 'tool_use',
            id: 'todo-2',
            name: 'write_todos',
            input: { todos: [{ content: 'Second', status: 'pending' }] },
          },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'retry later' }],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'end_turn',
      },
    ])
    const state = createAgentState()
    const agent = createAgent({ provider, middleware: [todoMiddleware()], maxTurns: 3 })

    for await (const _event of agent.run({ state })) {
      // consume stream
    }

    const toolMessages = state.messages.filter((message) => message.role === 'tool')
    expect(toolMessages).toHaveLength(2)
    expect(toolMessages.every((message) => message.content.includes('called multiple times'))).toBe(
      true,
    )
    expect(getTodoState(state.store).items).toEqual([])
  })

  it('injects reminders after the configured threshold', async () => {
    const provider = createProvider([
      {
        content: [{ type: 'text', text: 'ok' }],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'end_turn',
      },
    ])
    const state = createAgentState()
    state.store.todos = {
      items: [{ content: 'Finish work', status: 'pending' }],
      visibleItems: [{ content: 'Finish work', status: 'pending' }],
      lastWriteTurn: 0,
      turnCounter: 1,
    }
    const agent = createAgent({ provider, middleware: [todoMiddleware({ reminderTurns: 1 })] })

    for await (const _event of agent.run({ state })) {
      // consume stream
    }

    expect(provider.streamMock).toHaveBeenCalled()
    expect(provider.streamCalls[0]?.system).toContain('Todo reminder:')
  })
})
