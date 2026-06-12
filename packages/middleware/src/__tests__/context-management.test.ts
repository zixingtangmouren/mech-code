import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  ProviderError,
  ToolMessage,
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
import {
  CONTEXT_MANAGEMENT_STATE_KEY,
  contextManagementMiddleware,
} from '../context-management/index.js'
import type { ContextManagementState, SummarySource } from '../context-management/index.js'

interface MockProvider extends LLMProvider {
  streamMock: ReturnType<typeof vi.fn<(params: ChatParams, options?: CallOptions) => StreamResult>>
  streamCalls: ChatParams[]
}

interface SummaryMockProvider extends LLMProvider {
  chatMock: ReturnType<typeof vi.fn<LLMProvider['chat']>>
}

describe('contextManagementMiddleware', () => {
  it('projects large tool results before the next provider call without mutating state', async () => {
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
    expect(toolMessage.content).toBe(largeResult)

    const providerPayload = JSON.stringify(provider.streamCalls[1]?.messages)
    expect(providerPayload).toContain('Preview:')
    expect(providerPayload).not.toContain(largeResult)
  })

  it('does not duplicate provider previews for tool results recorded during tool calls', async () => {
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

    const contextState = state[CONTEXT_MANAGEMENT_STATE_KEY] as ContextManagementState
    expect(contextState.toolResults.call_1).toMatchObject({
      originalChars: largeResult.length,
      preview: 'xxxxxxxx',
      toolName: 'large_tool',
    })
    const toolMessage = state.messages.find((message) => message.role === 'tool')
    if (!toolMessage || toolMessage.role !== 'tool') throw new Error('Expected a tool message')
    expect(toolMessage.content).toBe(largeResult)
    const providerPayload = JSON.stringify(provider.streamCalls[1]?.messages)
    expect(providerPayload.match(/Tool result is large/g)).toHaveLength(1)
  })

  it('budgets unmanaged oversized tool messages already present in state', async () => {
    const rawToolResult = 'raw-tool-result-'.repeat(20)
    const provider = createProvider([
      {
        content: [{ type: 'text', text: 'ok' }],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'end_turn',
      },
    ])
    const state = createAgentState()
    state.messages.push(new ToolMessage('restored_call', 'restored_tool', rawToolResult))
    const agent = createAgent({
      provider,
      middleware: [
        contextManagementMiddleware({
          toolResults: {
            maxResultChars: 50,
            previewChars: 12,
          },
        }),
      ],
    })

    for await (const _event of agent.run({ state })) {
      // consume stream
    }

    const contextState = state[CONTEXT_MANAGEMENT_STATE_KEY] as ContextManagementState
    expect(contextState.toolResults.restored_call).toMatchObject({
      originalChars: rawToolResult.length,
      preview: rawToolResult.slice(0, 12),
      toolName: 'restored_tool',
    })
    const toolMessage = state.messages.find((message) => message.role === 'tool')
    if (!toolMessage || toolMessage.role !== 'tool') throw new Error('Expected a tool message')
    expect(toolMessage.content).toBe(rawToolResult)
    expect(JSON.stringify(provider.streamCalls[0]?.messages)).not.toContain(rawToolResult)
  })

  it('cleans old tool results in the provider projection without mutating state', async () => {
    const oldResult = 'old-result-that-business-must-persist'
    const recentResult = 'recent-result'
    const provider = createProvider([
      {
        content: [{ type: 'text', text: 'ok' }],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'end_turn',
      },
    ])
    const state = createAgentState()
    state.messages.push(
      new ToolMessage('old_call', 'old_tool', oldResult),
      new ToolMessage('recent_call', 'recent_tool', recentResult),
    )
    const agent = createAgent({
      provider,
      middleware: [
        contextManagementMiddleware({
          cleanup: {
            enabled: true,
            trigger: { turns: 1 },
            keepRecentToolResults: 1,
            replacementText: 'CLEARED_FOR_CONTEXT',
          },
        }),
      ],
    })

    for await (const _event of agent.run({ state })) {
      // consume stream
    }

    const toolMessages = state.messages.filter((message) => message.role === 'tool')
    expect(toolMessages[0]?.content).toBe(oldResult)
    expect(toolMessages[1]?.content).toBe(recentResult)
    const providerPayload = JSON.stringify(provider.streamCalls[0]?.messages)
    expect(providerPayload).toContain('CLEARED_FOR_CONTEXT')
    expect(providerPayload).not.toContain(oldResult)
    expect(providerPayload).toContain(recentResult)
    const contextState = state[CONTEXT_MANAGEMENT_STATE_KEY] as ContextManagementState
    expect(contextState.toolResults.old_call?.cleared).toBe(true)
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

  it('requests compact summaries with original messages and no tools', async () => {
    const provider = createProvider([
      {
        content: [{ type: 'text', text: 'ok' }],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'end_turn',
      },
    ])
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

    const summaryCall = summaryProvider.chatMock.mock.calls[0]?.[0]
    if (!summaryCall) throw new Error('Expected summary provider call')
    expect(summaryCall.system).toBe('Parent system prompt')
    expect(summaryCall.tools).toBeUndefined()
    expect(JSON.stringify(summaryCall.messages)).toContain('old request')
    expect(JSON.stringify(summaryCall.messages)).toContain('old detail')
    expect(JSON.stringify(summaryCall.messages)).not.toContain('latest request')

    const compactPrompt = summaryCall.messages[summaryCall.messages.length - 1]
    expect(compactPrompt?.role).toBe('user')
    expect(JSON.stringify(compactPrompt)).toContain('CRITICAL: Respond with TEXT ONLY')
    expect(JSON.stringify(compactPrompt)).toContain('Do NOT call any tools')
  })

  it('strips compact analysis scratchpad before inserting the summary message', async () => {
    const provider = createProvider([
      {
        content: [{ type: 'text', text: 'ok' }],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'end_turn',
      },
    ])
    const summaryProvider = createSummaryProvider(
      '<analysis>draft reasoning that should not survive</analysis><summary>Visible compact summary</summary>',
    )
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

    const providerPayload = JSON.stringify(provider.streamCalls[0]?.messages)
    expect(providerPayload).toContain('Summary:\\nVisible compact summary')
    expect(providerPayload).not.toContain('draft reasoning that should not survive')
    expect(providerPayload).not.toContain('<analysis>')
    expect(providerPayload).not.toContain('<summary>')
  })

  it('proactively compacts when provider-visible tokens exceed the configured fraction', async () => {
    const provider = createProvider([
      {
        content: [{ type: 'text', text: 'ok' }],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'end_turn',
      },
    ])
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
        contextManagementMiddleware({
          summaryProvider,
          modelContextWindow: 100,
          tokenCounter: (messages) => messages.length * 25,
          trigger: { fraction: 0.5 },
          keep: { messages: 1 },
        }),
      ],
    })

    for await (const _event of agent.run({ state })) {
      // consume stream
    }

    const contextState = state[CONTEXT_MANAGEMENT_STATE_KEY] as ContextManagementState
    expect(contextState.summaries).toHaveLength(1)
    const providerPayload = JSON.stringify(provider.streamCalls[0]?.messages)
    expect(providerPayload).toContain('fraction summary')
    expect(providerPayload).toContain('latest request')
    expect(providerPayload).not.toContain('old request')
  })

  it('does not compact by fraction while below the usable context window', async () => {
    const provider = createProvider([
      {
        content: [{ type: 'text', text: 'ok' }],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'end_turn',
      },
    ])
    const summaryProvider = createSummaryProvider('unexpected summary')
    const state = createAgentState()
    state.messages.push(new UserMessage('old request'), new UserMessage('still current'))
    const agent = createAgent({
      provider,
      middleware: [
        contextManagementMiddleware({
          summaryProvider,
          modelContextWindow: 100,
          tokenCounter: () => 39,
          trigger: { fraction: 0.5 },
          keep: { messages: 1 },
        }),
      ],
    })

    for await (const _event of agent.run({ state })) {
      // consume stream
    }

    const contextState = state[CONTEXT_MANAGEMENT_STATE_KEY] as ContextManagementState
    expect(contextState.summaries).toHaveLength(0)
    expect(summaryProvider.chatMock).not.toHaveBeenCalled()
    const providerPayload = JSON.stringify(provider.streamCalls[0]?.messages)
    expect(providerPayload).toContain('old request')
    expect(providerPayload).toContain('still current')
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
