import { describe, expect, it } from 'vitest'
import { createAgentState, deserializeAgentState, serializeAgentState } from '../../agent/state.js'
import { AssistantMessage, ToolMessage, UserMessage } from '../message.js'

describe('message classes', () => {
  it('creates class messages with createdAt metadata', () => {
    const before = Date.now()
    const user = new UserMessage('hello', { metadata: { source: 'test' } })
    const assistant = new AssistantMessage([{ type: 'text', text: 'ok' }])
    const tool = new ToolMessage('call_1', 'read_file', 'result')
    const after = Date.now()

    expect(user.role).toBe('user')
    expect(user.metadata.source).toBe('test')
    expect(user.metadata.createdAt).toBeGreaterThanOrEqual(before)
    expect(user.metadata.createdAt).toBeLessThanOrEqual(after)
    expect(assistant.metadata.createdAt).toBeGreaterThanOrEqual(before)
    expect(tool.metadata.createdAt).toBeGreaterThanOrEqual(before)
    expect(tool.toolCallId).toBe('call_1')
    expect(tool.toolName).toBe('read_file')
  })

  it('normalizes text shorthand when constructing user and assistant messages', () => {
    const user = new UserMessage('hello')
    const assistant = new AssistantMessage('I can help.')

    expect(user.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(assistant.content).toEqual([{ type: 'text', text: 'I can help.' }])
  })

  it('preserves content block arrays', () => {
    const userContent = [{ type: 'text' as const, text: 'hello' }]
    const assistantContent = [
      { type: 'text' as const, text: 'Let me check.' },
      { type: 'tool_use' as const, id: 'call_1', name: 'read_file', input: { path: 'foo.ts' } },
    ]

    expect(new UserMessage(userContent).content).toBe(userContent)
    expect(new AssistantMessage(assistantContent).content).toBe(assistantContent)
  })

  it('preserves provided createdAt metadata', () => {
    const user = new UserMessage('hello', { metadata: { createdAt: 123, source: 'test' } })

    expect(user.metadata).toEqual({ createdAt: 123, source: 'test' })
  })

  it('serializes state to canonical plain messages and restores message classes', () => {
    const state = createAgentState()
    state.messages.push(
      new UserMessage('hello', { metadata: { createdAt: 123, kind: 'test' } }),
      new ToolMessage('call_1', 'read_image', 'image result', {
        image: { type: 'base64', mediaType: 'image/png', data: 'abc' },
      }),
    )

    const serialized = serializeAgentState(state)
    expect(serialized.messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
      metadata: { createdAt: 123, kind: 'test' },
    })
    expect(serialized.messages[1]).toMatchObject({
      role: 'tool',
      toolCallId: 'call_1',
      image: { type: 'base64', mediaType: 'image/png', data: 'abc' },
    })

    const restored = deserializeAgentState(serialized)
    expect(restored.messages[0]).toBeInstanceOf(UserMessage)
    expect(restored.messages[0]?.metadata).toEqual({ createdAt: 123, kind: 'test' })
    expect(restored.messages[1]).toBeInstanceOf(ToolMessage)
    expect(restored.messages[1]).toMatchObject({
      image: { type: 'base64', mediaType: 'image/png', data: 'abc' },
    })
  })
})
