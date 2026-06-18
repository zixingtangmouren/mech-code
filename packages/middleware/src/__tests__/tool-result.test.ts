import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  AssistantMessage,
  ToolMessage,
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
import { TOOL_RESULT_STATE_KEY, toolResultMiddleware } from '../tool-result/index.js'
import type { ToolResultState } from '../tool-result/index.js'

interface MockProvider extends LLMProvider {
  streamMock: ReturnType<typeof vi.fn<(params: ChatParams, options?: CallOptions) => StreamResult>>
  streamCalls: ChatParams[]
}

describe('toolResultMiddleware', () => {
  it('projects large tool results before the next provider call without mutating state', async () => {
    const largeResult = 'x'.repeat(100)
    const provider = createProvider([
      assistantResponse(
        [{ type: 'tool_use', id: 'call_1', name: 'large_tool', input: {} }],
        'tool_use',
      ),
      assistantResponse([{ type: 'text', text: 'done' }]),
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
      middleware: [toolResultMiddleware({ maxResultChars: 20, previewChars: 8 })],
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
      assistantResponse(
        [{ type: 'tool_use', id: 'call_1', name: 'large_tool', input: {} }],
        'tool_use',
      ),
      assistantResponse([{ type: 'text', text: 'done' }]),
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
      middleware: [toolResultMiddleware({ maxResultChars: 20, previewChars: 8 })],
      maxTurns: 3,
    })

    for await (const _event of agent.run({ state })) {
      // consume stream
    }

    const toolResult = state[TOOL_RESULT_STATE_KEY] as ToolResultState
    expect(toolResult.records.call_1).toMatchObject({
      originalChars: largeResult.length,
      preview: 'xxxxxxxx',
      toolName: 'large_tool',
    })
    const providerPayload = JSON.stringify(provider.streamCalls[1]?.messages)
    expect(providerPayload.match(/Tool result is large/g)).toHaveLength(1)
  })

  it('budgets unmanaged oversized tool messages already present in state', async () => {
    const rawToolResult = 'raw-tool-result-'.repeat(20)
    const provider = createProvider([assistantResponse([{ type: 'text', text: 'ok' }])])
    const state = createAgentState()
    state.messages.push(new ToolMessage('restored_call', 'restored_tool', rawToolResult))
    const agent = createAgent({
      provider,
      middleware: [toolResultMiddleware({ maxResultChars: 50, previewChars: 12 })],
    })

    for await (const _event of agent.run({ state })) {
      // consume stream
    }

    const toolResult = state[TOOL_RESULT_STATE_KEY] as ToolResultState
    expect(toolResult.records.restored_call).toMatchObject({
      originalChars: rawToolResult.length,
      preview: rawToolResult.slice(0, 12),
      toolName: 'restored_tool',
    })
    expect(JSON.stringify(provider.streamCalls[0]?.messages)).not.toContain(rawToolResult)
  })

  it('cleans expired tool results in the provider projection without mutating state', async () => {
    const oldResult = 'old-result-that-business-must-persist'
    const recentResult = 'recent-result'
    const provider = createProvider([assistantResponse([{ type: 'text', text: 'ok' }])])
    const state = createAgentState()
    state.messages.push(
      new ToolMessage('old_call', 'old_tool', oldResult, { metadata: { createdAt: 1 } }),
      new ToolMessage('recent_call', 'recent_tool', recentResult, {
        metadata: { createdAt: Date.now() },
      }),
    )
    const agent = createAgent({
      provider,
      middleware: [
        toolResultMiddleware({
          cleanup: {
            maxAgeMs: 1_000,
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
    const toolResult = state[TOOL_RESULT_STATE_KEY] as ToolResultState
    expect(toolResult.records.old_call?.cleared).toBe(true)
    expect(toolResult.records.recent_call?.cleared).toBeUndefined()
  })

  it('does not clean tool results when maxAgeMs is not configured', async () => {
    const oldResult = 'old-result'
    const provider = createProvider([assistantResponse([{ type: 'text', text: 'ok' }])])
    const state = createAgentState()
    state.messages.push(
      new ToolMessage('old_call', 'old_tool', oldResult, { metadata: { createdAt: 1 } }),
    )
    const agent = createAgent({
      provider,
      middleware: [
        toolResultMiddleware({
          cleanup: {
            replacementText: 'CLEARED_FOR_CONTEXT',
          },
        }),
      ],
    })

    for await (const _event of agent.run({ state })) {
      // consume stream
    }

    const providerPayload = JSON.stringify(provider.streamCalls[0]?.messages)
    expect(providerPayload).toContain(oldResult)
    expect(providerPayload).not.toContain('CLEARED_FOR_CONTEXT')
    const toolResult = state[TOOL_RESULT_STATE_KEY] as ToolResultState
    expect(toolResult.records.old_call?.cleared).toBeUndefined()
  })
})

function createProvider(finals: ChatResponse[]): MockProvider {
  let index = 0
  const streamCalls: ChatParams[] = []
  const streamMock = vi.fn((params: ChatParams, _options?: CallOptions): StreamResult => {
    streamCalls.push(params)
    const next = finals[index++]!
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
