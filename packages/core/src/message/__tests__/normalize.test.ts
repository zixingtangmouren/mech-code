import { describe, expect, it } from 'vitest'
import { normalizeMessage, normalizeMessages, denormalizeMessage } from '../normalize.js'
import { AssistantMessage, SystemMessage, ToolMessage, UserMessage } from '../message.js'
import { createAgentState, deserializeAgentState, serializeAgentState } from '../../agent/state.js'

describe('message classes', () => {
  it('creates class messages with metadata', () => {
    const user = new UserMessage('hello', { metadata: { source: 'test' } })
    const assistant = new AssistantMessage([{ type: 'text', text: 'ok' }])
    const tool = new ToolMessage('call_1', 'result')

    expect(user.role).toBe('user')
    expect(user.metadata).toEqual({ source: 'test' })
    expect(assistant.metadata).toEqual({})
    expect(tool.toolCallId).toBe('call_1')
  })

  it('serializes state to plain json and restores message classes', () => {
    const state = createAgentState()
    state.messages.push(new UserMessage('hello', { metadata: { kind: 'test' } }))

    const serialized = serializeAgentState(state)
    expect(serialized.messages[0]).toEqual({
      role: 'user',
      content: 'hello',
      metadata: { kind: 'test' },
    })

    const restored = deserializeAgentState(serialized)
    expect(restored.messages[0]).toBeInstanceOf(UserMessage)
    expect(restored.messages[0]?.metadata).toEqual({ kind: 'test' })
  })
})

describe('normalizeMessage', () => {
  it('passes system message through unchanged', () => {
    const msg = new SystemMessage('You are helpful.')
    expect(normalizeMessage(msg)).toEqual({ role: 'system', content: 'You are helpful.' })
  })

  it('passes tool message through unchanged', () => {
    const msg = new ToolMessage('call_1', '{"ok":true}')
    expect(normalizeMessage(msg)).toEqual({
      role: 'tool',
      toolCallId: 'call_1',
      content: '{"ok":true}',
    })
  })

  it('wraps user string content into text block array', () => {
    const msg = new UserMessage('hello', { metadata: { hidden: true } })
    expect(normalizeMessage(msg)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    })
  })

  it('passes user array content through unchanged', () => {
    const msg = new UserMessage([{ type: 'text', text: 'hello' }])
    expect(normalizeMessage(msg)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    })
  })

  it('wraps assistant string content into text block array', () => {
    const msg = new AssistantMessage('I can help.')
    expect(normalizeMessage(msg)).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'I can help.' }],
    })
  })

  it('preserves assistant message with tool_use blocks', () => {
    const content = [
      { type: 'text', text: 'Let me check.' },
      { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'foo.ts' } },
    ] as const
    const msg = new AssistantMessage([...content])
    expect(normalizeMessage(msg)).toEqual({ role: 'assistant', content: [...content] })
  })

  it('maps tool image metadata to internal image data', () => {
    const msg = new ToolMessage('call_1', 'image result', {
      metadata: { imageData: { base64: 'abc', mediaType: 'image/png' } },
    })

    expect(normalizeMessage(msg)).toEqual({
      role: 'tool',
      toolCallId: 'call_1',
      content: 'image result',
      _imageData: { base64: 'abc', mediaType: 'image/png' },
    })
  })
})

describe('normalizeMessages', () => {
  it('normalizes multiple messages', () => {
    const msgs = [new SystemMessage('sys'), new UserMessage('hi')]
    const result = normalizeMessages(msgs)
    expect(result[1]).toEqual({ role: 'user', content: [{ type: 'text', text: 'hi' }] })
  })
})

describe('denormalizeMessage', () => {
  it('simplifies single-text-block assistant message to string', () => {
    const internal = {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'Hello!' }],
    }
    expect(denormalizeMessage(internal)).toEqual({ role: 'assistant', content: 'Hello!' })
  })

  it('keeps assistant message with multiple blocks as array', () => {
    const internal = {
      role: 'assistant' as const,
      content: [
        { type: 'text' as const, text: 'Checking.' },
        { type: 'tool_use' as const, id: 'c1', name: 'search', input: {} },
      ],
    }
    const result = denormalizeMessage(internal)
    expect(result).toEqual(internal)
  })

  it('simplifies single-text-block user message to string', () => {
    const internal = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'hi' }],
    }
    expect(denormalizeMessage(internal)).toEqual({ role: 'user', content: 'hi' })
  })
})
