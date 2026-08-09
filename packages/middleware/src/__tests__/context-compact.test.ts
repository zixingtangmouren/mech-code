import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  AssistantMessage,
  ProviderError,
  UserMessage,
  createAgent,
  createAgentState,
  defineTool,
} from '@mech-code/core'
import type {
  AgentEvent,
  CallOptions,
  ChatParams,
  ChatResponse,
  LLMProvider,
  StreamResult,
} from '@mech-code/core'
import {
  CONTEXT_COMPACT_STATE_KEY,
  contextCompactMiddleware,
  isContextCompactEvent,
} from '../context-compact/index.js'
import type { ContextCompactState, SummarySource } from '../context-compact/index.js'
import { toolResultMiddleware } from '../tool-result/index.js'

interface MockProvider extends LLMProvider {
  streamMock: ReturnType<typeof vi.fn<(params: ChatParams, options?: CallOptions) => StreamResult>>
  streamCalls: ChatParams[]
}

interface SummaryMockProvider extends LLMProvider {
  chatMock: ReturnType<typeof vi.fn<LLMProvider['chat']>>
}

describe('contextCompactMiddleware', () => {
  it('proactively compacts visible history and filters compressed messages in wrapModelCall', async () => {
    const provider = createProvider([assistantResponse([{ type: 'text', text: 'ok' }])])
    const summaryProvider = createSummaryProvider('important summary')
    const state = createAgentState()
    state.messages.push(
      new UserMessage('old request'),
      new UserMessage('old detail'),
      new UserMessage('latest request'),
    )
    const agent = createAgent({
      provider,
      middleware: [contextCompactMiddleware({ summaryProvider, trigger: { messages: 3 } })],
    })

    const events: AgentEvent[] = []
    for await (const event of agent.run({ state })) {
      events.push(event)
    }

    const compactState = state[CONTEXT_COMPACT_STATE_KEY] as ContextCompactState
    expect(compactState.summaries).toHaveLength(1)
    expect(state.messages[0]?.metadata.contextCompact).toMatchObject({ compressed: true })
    const providerPayload = JSON.stringify(provider.streamCalls[0]?.messages)
    expect(providerPayload).toContain('important summary')
    expect(providerPayload).not.toContain('latest request')
    expect(providerPayload).not.toContain('old request')
    const compactEvents = events.filter(isContextCompactEvent)
    expect(compactEvents).toEqual([
      expect.objectContaining({
        type: 'custom',
        source: 'context-compact',
        name: 'started',
        payload: { mode: 'proactive' },
      }),
      expect.objectContaining({
        type: 'custom',
        source: 'context-compact',
        name: 'completed',
      }),
    ])
    expect(compactEvents[1]?.payload).toMatchObject({
      mode: 'proactive',
      compressedMessageCount: 3,
    })
  })

  it('requests compact summaries with original messages and no tools', async () => {
    const provider = createProvider([assistantResponse([{ type: 'text', text: 'ok' }])])
    const summaryProvider = createSummaryProvider('tool-free summary')
    const state = createAgentState()
    state.messages.push(
      new UserMessage('old request'),
      new UserMessage('old detail'),
      new UserMessage('latest request'),
    )
    const agent = createAgent({
      provider,
      system: 'Parent system prompt',
      middleware: [contextCompactMiddleware({ summaryProvider, trigger: { messages: 3 } })],
    })

    for await (const _event of agent.run({ state })) {
      // consume stream
    }

    const summaryCall = summaryProvider.chatMock.mock.calls[0]?.[0]
    if (!summaryCall) throw new Error('Expected summary provider call')
    expect(summaryCall.system).toBe('Parent system prompt')
    expect(summaryCall.tools).toBeUndefined()
    expect(JSON.stringify(summaryCall.messages)).toContain('old request')
    expect(JSON.stringify(summaryCall.messages)).toContain('old detail')
    expect(JSON.stringify(summaryCall.messages)).toContain('latest request')
    expect(JSON.stringify(summaryCall.messages.at(-1))).toContain(
      'CRITICAL: Respond with TEXT ONLY',
    )
  })

  it('strips compact analysis scratchpad before inserting the summary message', async () => {
    const provider = createProvider([assistantResponse([{ type: 'text', text: 'ok' }])])
    const summaryProvider = createSummaryProvider(
      '<analysis>draft reasoning that should not survive</analysis><summary>Visible compact summary</summary>',
    )
    const state = createAgentState()
    state.messages.push(new UserMessage('old request'), new UserMessage('latest request'))
    const agent = createAgent({
      provider,
      middleware: [contextCompactMiddleware({ summaryProvider, trigger: { messages: 2 } })],
    })

    for await (const _event of agent.run({ state })) {
      // consume stream
    }

    const providerPayload = JSON.stringify(provider.streamCalls[0]?.messages)
    expect(providerPayload).toContain('Summary:\\nVisible compact summary')
    expect(providerPayload).not.toContain('draft reasoning that should not survive')
    expect(providerPayload).not.toContain('<analysis>')
    expect(providerPayload).not.toContain('<summary>')
  })

  it('proactively compacts when provider-visible tokens exceed the configured fraction', async () => {
    const provider = createProvider([assistantResponse([{ type: 'text', text: 'ok' }])])
    const summaryProvider = createSummaryProvider('fraction summary')
    const state = createAgentState()
    state.messages.push(
      new UserMessage('old request'),
      new UserMessage('old detail'),
      new UserMessage('latest request'),
    )
    const agent = createAgent({
      provider,
      middleware: [
        contextCompactMiddleware({
          summaryProvider,
          modelContextWindow: 100,
          tokenCounter: (messages) => messages.length * 25,
          trigger: { fraction: 0.5 },
        }),
      ],
    })

    for await (const _event of agent.run({ state })) {
      // consume stream
    }

    const compactState = state[CONTEXT_COMPACT_STATE_KEY] as ContextCompactState
    expect(compactState.summaries).toHaveLength(1)
    expect(JSON.stringify(provider.streamCalls[0]?.messages)).toContain('fraction summary')
  })

  it('does not compact by fraction while below the context window', async () => {
    const provider = createProvider([assistantResponse([{ type: 'text', text: 'ok' }])])
    const summaryProvider = createSummaryProvider('unexpected summary')
    const state = createAgentState()
    state.messages.push(new UserMessage('old request'), new UserMessage('still current'))
    const agent = createAgent({
      provider,
      middleware: [
        contextCompactMiddleware({
          summaryProvider,
          modelContextWindow: 100,
          tokenCounter: () => 39,
          trigger: { fraction: 0.5 },
        }),
      ],
    })

    for await (const _event of agent.run({ state })) {
      // consume stream
    }

    const compactState = state[CONTEXT_COMPACT_STATE_KEY] as ContextCompactState
    expect(compactState.summaries).toHaveLength(0)
    expect(summaryProvider.chatMock).not.toHaveBeenCalled()
    expect(JSON.stringify(provider.streamCalls[0]?.messages)).toContain('old request')
  })

  it('uses a fresh SummarySource when configured', async () => {
    const provider = createProvider([assistantResponse([{ type: 'text', text: 'ok' }])])
    const summaryProvider = createSummaryProvider('regenerated summary')
    const source: SummarySource = {
      name: 'session-note',
      load: vi.fn(() => ({ content: 'fresh session note', fresh: true })),
    }
    const state = createAgentState()
    state.messages.push(new UserMessage('old request'), new UserMessage('latest request'))
    const agent = createAgent({
      provider,
      middleware: [
        contextCompactMiddleware({
          summaryProvider,
          trigger: { messages: 2 },
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

  it('regenerates summaries when sourcePolicy is always_regenerate', async () => {
    const provider = createProvider([assistantResponse([{ type: 'text', text: 'ok' }])])
    const summaryProvider = createSummaryProvider('regenerated summary')
    const source: SummarySource = {
      name: 'session-note',
      load: vi.fn(() => ({ content: 'fresh session note', fresh: true })),
    }
    const state = createAgentState()
    state.messages.push(new UserMessage('old request'), new UserMessage('latest request'))
    const agent = createAgent({
      provider,
      middleware: [
        contextCompactMiddleware({
          summaryProvider,
          trigger: { messages: 2 },
          summary: { sources: [source], sourcePolicy: 'always_regenerate' },
        }),
      ],
    })

    for await (const _event of agent.run({ state })) {
      // consume stream
    }

    expect(summaryProvider.chatMock).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(summaryProvider.chatMock.mock.calls[0]?.[0].messages)).not.toContain(
      'fresh session note',
    )
    expect(JSON.stringify(provider.streamCalls[0]?.messages)).toContain('regenerated summary')
  })

  it('reactively compacts and retries context_too_long stream failures', async () => {
    const provider = createProvider([
      new ProviderError('context_too_long', 'mock', 'too long'),
      assistantResponse([{ type: 'text', text: 'recovered' }]),
    ])
    const summaryProvider = createSummaryProvider('reactive summary')
    const state = createAgentState()
    state.messages.push(new UserMessage('old request'), new UserMessage('latest request'))
    const agent = createAgent({
      provider,
      middleware: [
        contextCompactMiddleware({ summaryProvider, reactiveCompact: { maxRetries: 1 } }),
      ],
    })

    const events: AgentEvent[] = []
    for await (const event of agent.run({ state })) {
      events.push(event)
    }

    expect(provider.streamMock).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(provider.streamCalls[1]?.messages)).toContain('reactive summary')
    expect(JSON.stringify(provider.streamCalls[1]?.messages)).not.toContain('old request')
    expect(JSON.stringify(provider.streamCalls[1]?.messages)).not.toContain('latest request')
    expect(
      events.filter(isContextCompactEvent).map((event) => [event.name, event.payload.mode]),
    ).toEqual([
      ['started', 'reactive'],
      ['completed', 'reactive'],
    ])
  })

  it('emits reactive started before summary generation completes', async () => {
    const provider = createProvider([
      new ProviderError('context_too_long', 'mock', 'too long'),
      assistantResponse([{ type: 'text', text: 'recovered' }]),
    ])
    let resolveSummary: ((response: ChatResponse) => void) | undefined
    let markSummaryStarted: (() => void) | undefined
    const summaryStarted = new Promise<void>((resolve) => {
      markSummaryStarted = resolve
    })
    const summaryProvider: LLMProvider = {
      name: 'summary',
      chat: vi.fn(
        () =>
          new Promise<ChatResponse>((resolve) => {
            resolveSummary = resolve
            markSummaryStarted?.()
          }),
      ),
      stream: vi.fn(),
    }
    const state = createAgentState()
    state.messages.push(new UserMessage('old request'), new UserMessage('latest request'))
    const agent = createAgent({
      provider,
      middleware: [
        contextCompactMiddleware({ summaryProvider, reactiveCompact: { maxRetries: 1 } }),
      ],
    })
    const iterator = agent.run({ state })[Symbol.asyncIterator]()

    expect((await iterator.next()).value).toMatchObject({ type: 'agent_run_start' })
    expect((await iterator.next()).value).toMatchObject({ type: 'turn_start' })
    const compactStartedEvent = iterator.next()
    await summaryStarted
    expect((await compactStartedEvent).value).toMatchObject({
      type: 'custom',
      source: 'context-compact',
      name: 'started',
      payload: { mode: 'reactive' },
    })

    resolveSummary?.(assistantResponse([{ type: 'text', text: 'reactive summary' }]))
    const remainingEvents: AgentEvent[] = []
    while (true) {
      const result = await iterator.next()
      if (result.done) break
      remainingEvents.push(result.value)
    }
    expect(remainingEvents.filter(isContextCompactEvent).map((event) => event.name)).toContain(
      'completed',
    )
  })

  it('emits a failed event when summary generation fails', async () => {
    const provider = createProvider([assistantResponse([{ type: 'text', text: 'ok' }])])
    const summaryProvider = createSummaryProvider('unused')
    summaryProvider.chatMock.mockRejectedValueOnce(new Error('summary unavailable'))
    const state = createAgentState()
    state.messages.push(new UserMessage('old request'), new UserMessage('latest request'))
    const agent = createAgent({
      provider,
      middleware: [contextCompactMiddleware({ summaryProvider, trigger: { messages: 2 } })],
    })
    const events: AgentEvent[] = []

    for await (const event of agent.run({ state })) {
      events.push(event)
    }

    expect(events.filter(isContextCompactEvent)).toEqual([
      expect.objectContaining({
        name: 'started',
        payload: { mode: 'proactive' },
      }),
      expect.objectContaining({
        name: 'failed',
        payload: { mode: 'proactive', error: 'summary unavailable' },
      }),
    ])
  })

  it('does not emit compact events when compaction is not triggered', async () => {
    const provider = createProvider([assistantResponse([{ type: 'text', text: 'ok' }])])
    const state = createAgentState()
    state.messages.push(new UserMessage('short request'))
    const agent = createAgent({
      provider,
      middleware: [contextCompactMiddleware({ trigger: { messages: 2 } })],
    })
    const events: AgentEvent[] = []

    for await (const event of agent.run({ state })) {
      events.push(event)
    }

    expect(events.filter(isContextCompactEvent)).toEqual([])
  })

  it('compacts projected tool result previews when combined with toolResultMiddleware', async () => {
    const largeResult = 'large-result-'.repeat(30)
    const provider = createProvider([
      assistantResponse(
        [{ type: 'tool_use', id: 'call_1', name: 'large_tool', input: {} }],
        'tool_use',
      ),
      assistantResponse([{ type: 'text', text: 'done' }]),
    ])
    const summaryProvider = createSummaryProvider('summary from preview')
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
        toolResultMiddleware({ maxResultChars: 20, previewChars: 12 }),
        contextCompactMiddleware({ summaryProvider, trigger: { messages: 2 } }),
      ],
      maxTurns: 3,
    })

    for await (const _event of agent.run({ state })) {
      // consume stream
    }

    const summaryCall = summaryProvider.chatMock.mock.calls[0]?.[0]
    if (!summaryCall) throw new Error('Expected summary provider call')
    const summaryPayload = JSON.stringify(summaryCall.messages)
    expect(summaryPayload).toContain('Preview:')
    expect(summaryPayload).not.toContain(largeResult)
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
          message: new AssistantMessage([]),
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
    message: new AssistantMessage([{ type: 'text', text: summary }]),
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
