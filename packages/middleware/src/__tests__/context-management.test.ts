import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  ProviderError,
  UserMessage,
  createAgent,
  createAgentState,
  defineTool,
} from '@mech-code/core'
import type {
  CallOptions,
  ChatParams,
  ChatResponse,
  LLMProvider,
  StreamResult,
} from '@mech-code/core'
import { CONTEXT_MANAGEMENT_STATE_KEY, contextManagementMiddleware } from '../context-management.js'
import type { ContextManagementState, SummarySource } from '../context-management.js'

interface MockProvider extends LLMProvider {
  streamMock: ReturnType<typeof vi.fn<(params: ChatParams, options?: CallOptions) => StreamResult>>
  streamCalls: ChatParams[]
}

interface SummaryMockProvider extends LLMProvider {
  chatMock: ReturnType<typeof vi.fn<LLMProvider['chat']>>
}

describe('contextManagementMiddleware', () => {
  it('shortens large tool results before the next provider call', async () => {
    const largeResult = 'x'.repeat(100)
    const provider = createProvider([
      {
        content: [{ type: 'tool_use', id: 'call_1', name: 'large_tool', input: {} }],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'done' }],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'end_turn',
      },
    ])
    const tool = defineTool({
      name: 'large_tool',
      description: 'returns a large result',
      schema: z.object({}),
      flags: { readonly: true, parallelSafe: true },
      execute: () => ({ content: largeResult }),
    })
    const state = createAgentState()
    const agent = createAgent({
      provider,
      tools: [tool],
      middleware: [
        contextManagementMiddleware({
          toolResults: { maxResultChars: 20, previewChars: 8 },
        }),
      ],
      maxTurns: 3,
    })

    for await (const _event of agent.run({ state })) {
      // consume stream
    }

    const toolMessage = state.messages.find((message) => message.role === 'tool')
    if (!toolMessage || toolMessage.role !== 'tool') throw new Error('Expected a tool message')
    expect(toolMessage.content).toContain('Preview:')
    expect(toolMessage.content).not.toContain(largeResult)
    expect(
      provider.streamCalls[1]?.messages.some((message) =>
        JSON.stringify(message).includes(largeResult),
      ),
    ).toBe(false)
  })

  it('proactively compacts visible history and filters compressed messages in wrapModelCall', async () => {
    const provider = createProvider([
      {
        content: [{ type: 'text', text: 'ok' }],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'end_turn',
      },
    ])
    const summaryProvider = createSummaryProvider('important summary')
    const state = createAgentState()
    state.messages.push(
      new UserMessage('old request'),
      new UserMessage('old detail'),
      new UserMessage('latest request'),
    )
    const agent = createAgent({
      provider,
      middleware: [
        contextManagementMiddleware({
          summaryProvider,
          trigger: { messages: 3 },
          keep: { messages: 1 },
        }),
      ],
    })

    for await (const _event of agent.run({ state })) {
      // consume stream
    }

    const contextState = state[CONTEXT_MANAGEMENT_STATE_KEY] as ContextManagementState
    expect(contextState.summaries).toHaveLength(1)
    expect(state.messages[0]?.metadata.contextManagement).toMatchObject({
      compressed: true,
    })
    const providerPayload = JSON.stringify(provider.streamCalls[0]?.messages)
    expect(providerPayload).toContain('important summary')
    expect(providerPayload).toContain('latest request')
    expect(providerPayload).not.toContain('old request')
  })

  it('uses a fresh SummarySource when configured', async () => {
    const provider = createProvider([
      {
        content: [{ type: 'text', text: 'ok' }],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'end_turn',
      },
    ])
    const summaryProvider = createSummaryProvider('regenerated summary')
    const source: SummarySource = {
      name: 'session-note',
      load: vi.fn(() => ({ content: 'fresh session note', fresh: true })),
    }
    const state = createAgentState()
    state.messages.push(
      new UserMessage('old request'),
      new UserMessage('old detail'),
      new UserMessage('latest request'),
    )
    const agent = createAgent({
      provider,
      middleware: [
        contextManagementMiddleware({
          summaryProvider,
          trigger: { messages: 3 },
          keep: { messages: 1 },
          summary: { sources: [source], sourcePolicy: 'prefer_fresh_source' },
        }),
      ],
    })

    for await (const _event of agent.run({ state })) {
      // consume stream
    }

    expect(summaryProvider.chatMock).not.toHaveBeenCalled()
    expect(JSON.stringify(provider.streamCalls[0]?.messages)).toContain('fresh session note')
  })

  it('reactively compacts and retries context_too_long stream failures', async () => {
    const provider = createProvider([
      new ProviderError('context_too_long', 'mock', 'too long'),
      {
        content: [{ type: 'text', text: 'recovered' }],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'end_turn',
      },
    ])
    const summaryProvider = createSummaryProvider('reactive summary')
    const state = createAgentState()
    state.messages.push(new UserMessage('old request'), new UserMessage('latest request'))
    const agent = createAgent({
      provider,
      middleware: [
        contextManagementMiddleware({
          summaryProvider,
          reactiveCompact: { maxRetries: 1, fallbackKeep: { messages: 1 } },
        }),
      ],
    })

    for await (const _event of agent.run({ state })) {
      // consume stream
    }

    expect(provider.streamMock).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(provider.streamCalls[1]?.messages)).toContain('reactive summary')
    expect(JSON.stringify(provider.streamCalls[1]?.messages)).not.toContain('old request')
  })
})

function createProvider(finals: Array<ChatResponse | Error>): MockProvider {
  let index = 0
  const streamCalls: ChatParams[] = []
  const streamMock = vi.fn((params: ChatParams, _options?: CallOptions): StreamResult => {
    streamCalls.push(params)
    const next = finals[index++]!
    if (next instanceof Error) {
      return {
        stream: (async function* () {
          throw next
        })(),
        final: Promise.resolve({
          content: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: 'error',
        }),
        abort: vi.fn(),
      }
    }

    return {
      stream: (async function* () {})(),
      final: Promise.resolve(next),
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

function createSummaryProvider(summary: string): SummaryMockProvider {
  const response: ChatResponse = {
    content: [{ type: 'text', text: summary }],
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: 'end_turn',
  }
  const chatMock = vi.fn<LLMProvider['chat']>(async () => response)
  return {
    name: 'summary',
    chat: chatMock,
    chatMock,
    stream: vi.fn(),
  }
}
