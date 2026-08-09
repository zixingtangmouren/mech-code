import { describe, expect, it, vi } from 'vitest'
import {
  AssistantMessage,
  UserMessage,
  createAgent,
  createAgentState,
  createMiddleware,
} from '@mech-code/core'
import type {
  AgentEvent,
  AgentState,
  CallOptions,
  ChatParams,
  ChatResponse,
  LLMProvider,
  StreamResult,
} from '@mech-code/core'
import { TODO_STORE_KEY, isTodoUpdatedEvent, todoMiddleware } from '../todo.js'
import type { TodoState } from '../todo.js'

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
    const provider = createProvider([assistantResponse([{ type: 'text', text: 'ok' }])])
    const state = createAgentState()
    const agent = createAgent({ provider, middleware: [todoMiddleware()] })

    for await (const _event of agent.run({ state })) {
      // consume stream
    }

    expect(readTodoState(state)).toMatchObject({ items: [] })
    expect(provider.streamMock).toHaveBeenCalled()
    expect(provider.streamCalls[0]?.tools?.some((tool) => tool.name === 'write_todos')).toBe(true)
  })

  it('updates items from write_todos', async () => {
    const provider = createProvider([
      assistantResponse(
        [
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
                },
              ],
            },
          },
        ],
        'tool_use',
      ),
      assistantResponse([{ type: 'text', text: 'done' }]),
    ])
    const state = createAgentState()
    const agent = createAgent({ provider, middleware: [todoMiddleware()], maxTurns: 3 })

    const events: AgentEvent[] = []
    for await (const event of agent.run({ state })) {
      events.push(event)
    }

    const todos = readTodoState(state)
    expect(todos.items).toHaveLength(2)
    expect(todos.items[1]).toEqual({ content: 'Implement middleware', status: 'in_progress' })
    expect(todos.lastWriteTurn).toBe(0)
    expect(events.filter(isTodoUpdatedEvent)).toEqual([
      expect.objectContaining({
        type: 'custom',
        source: 'todo',
        name: 'updated',
        payload: {
          items: [
            { content: 'Inspect code', status: 'completed' },
            { content: 'Implement middleware', status: 'in_progress' },
          ],
        },
      }),
    ])
  })

  it('clears todo state when all todos are completed', async () => {
    const provider = createProvider([
      assistantResponse(
        [
          {
            type: 'tool_use',
            id: 'todo-1',
            name: 'write_todos',
            input: { todos: [{ content: 'Verify', status: 'completed' }] },
          },
        ],
        'tool_use',
      ),
      assistantResponse([{ type: 'text', text: 'done' }]),
    ])
    const state = createAgentState()
    state[TODO_STORE_KEY] = {
      items: [{ content: 'Previous', status: 'in_progress' }],
      lastWriteTurn: 0,
      lastReminderTurn: 0,
      turnCounter: 1,
      writeCallCountByTurn: { 0: 1 },
    }
    const agent = createAgent({ provider, middleware: [todoMiddleware()], maxTurns: 3 })

    const events: AgentEvent[] = []
    for await (const event of agent.run({ state })) {
      events.push(event)
    }

    const todos = readTodoState(state)
    expect(todos.items).toEqual([])
    expect(todos.lastWriteTurn).toBeUndefined()
    expect(todos.lastReminderTurn).toBeUndefined()
    expect(todos.writeCallCountByTurn).toEqual({})
    expect(events.filter(isTodoUpdatedEvent)[0]?.payload.items).toEqual([])
  })

  it('rejects multiple write_todos calls in one assistant turn', async () => {
    const provider = createProvider([
      assistantResponse(
        [
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
        'tool_use',
      ),
      assistantResponse([{ type: 'text', text: 'retry later' }]),
    ])
    const state = createAgentState()
    const agent = createAgent({ provider, middleware: [todoMiddleware()], maxTurns: 3 })

    const events: AgentEvent[] = []
    for await (const event of agent.run({ state })) {
      events.push(event)
    }

    const toolMessages = state.messages.filter((message) => message.role === 'tool')
    expect(toolMessages).toHaveLength(2)
    expect(
      toolMessages.every((message) =>
        getMessageText(message.content).includes('called multiple times'),
      ),
    ).toBe(true)
    expect(readTodoState(state).items).toEqual([])
    expect(events.filter(isTodoUpdatedEvent)).toEqual([])
  })

  it('injects reminder as an agent user message before the latest user message when both thresholds are met', async () => {
    const observedMessages: AgentState['messages'][] = []
    const provider = createProvider([assistantResponse([{ type: 'text', text: 'ok' }])])
    const state = createAgentState()
    state.messages.push(new UserMessage('continue'))
    state[TODO_STORE_KEY] = {
      items: [{ content: 'Finish work', status: 'pending' }],
      lastWriteTurn: 0,
      lastReminderTurn: 0,
      turnCounter: 3,
    }
    const agent = createAgent({
      provider,
      middleware: [
        todoMiddleware({ turnsBetweenReminders: 2, turnsSinceWrite: 3 }),
        createMiddleware({
          name: 'observe-messages',
          beforeModel(ctx) {
            observedMessages.push(structuredClone(ctx.state.messages))
          },
        }),
      ],
    })

    for await (const _event of agent.run({ state })) {
      // consume stream
    }

    expect(provider.streamMock).toHaveBeenCalled()
    expect(provider.streamCalls[0]?.system).not.toContain('Todo reminder:')
    expect(observedMessages[0]).toHaveLength(2)
    const injectedMessage = observedMessages[0]?.[0]
    expect(injectedMessage?.role).toBe('user')
    expect(getMessageText(injectedMessage?.content)).toContain('Todo reminder:')
    expect(injectedMessage?.metadata).toMatchObject({
      source: 'agent',
      injected: true,
      kind: 'todo_reminder',
    })
    expect(observedMessages[0]?.[1]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'continue' }],
    })
    expect(provider.streamCalls[0]?.messages).toHaveLength(2)
    const providerReminderMessage = provider.streamCalls[0]?.messages[0]
    expect(providerReminderMessage?.role).toBe('user')
    expect(getMessageText(providerReminderMessage?.content)).toContain('Todo reminder:')
    expect(providerReminderMessage?.metadata).toMatchObject({
      source: 'agent',
      injected: true,
      kind: 'todo_reminder',
    })
    expect(provider.streamCalls[0]?.messages[1]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'continue' }],
    })
    expect(state.messages).toHaveLength(3)
    expect(state.messages[0]).toMatchObject({
      role: 'user',
      metadata: { source: 'agent', injected: true, kind: 'todo_reminder' },
    })
    expect(state.messages[1]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'continue' }],
    })
    expect(state.messages[2]).toMatchObject({ role: 'assistant' })
    expect(readTodoState(state).lastReminderTurn).toBe(3)
  })

  it('does not inject reminder until both reminder thresholds are met', async () => {
    const provider = createProvider([assistantResponse([{ type: 'text', text: 'ok' }])])
    const state = createAgentState()
    state.messages.push(new UserMessage('continue'))
    state[TODO_STORE_KEY] = {
      items: [{ content: 'Finish work', status: 'pending' }],
      lastWriteTurn: 0,
      lastReminderTurn: 2,
      turnCounter: 3,
    }
    const agent = createAgent({
      provider,
      middleware: [todoMiddleware({ turnsBetweenReminders: 2, turnsSinceWrite: 3 })],
    })

    for await (const _event of agent.run({ state })) {
      // consume stream
    }

    expect(provider.streamMock).toHaveBeenCalled()
    expect(provider.streamCalls[0]?.system).not.toContain('Todo reminder:')
    expect(provider.streamCalls[0]?.messages).toHaveLength(1)
    expect(readTodoState(state).lastReminderTurn).toBe(2)
  })
})

function readTodoState(state: AgentState): TodoState {
  return state[TODO_STORE_KEY] as TodoState
}

function assistantResponse(
  content: ConstructorParameters<typeof AssistantMessage>[0],
  stopReason = 'end_turn',
): ChatResponse {
  return {
    message: new AssistantMessage(content),
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason,
  }
}

function getMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === 'object' && 'text' in block
          ? String((block as { text: unknown }).text)
          : '',
      )
      .join('')
  }
  return ''
}
