import { describe, expect, it } from 'vitest'
import { normalizeMessage, normalizeMessages, denormalizeMessage } from '../normalize.js'
import type { Message } from '@mech/shared'

describe('normalizeMessage', () => {
  it('passes system message through unchanged', () => {
    const msg: Message = { role: 'system', content: 'You are helpful.' }
    expect(normalizeMessage(msg)).toEqual(msg)
  })

  it('passes tool message through unchanged', () => {
    const msg: Message = { role: 'tool', toolCallId: 'call_1', content: '{"ok":true}' }
    expect(normalizeMessage(msg)).toEqual(msg)
  })

  it('wraps user string content into text block array', () => {
    const msg: Message = { role: 'user', content: 'hello' }
    expect(normalizeMessage(msg)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    })
  })

  it('passes user array content through unchanged', () => {
    const msg: Message = {
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    }
    expect(normalizeMessage(msg)).toEqual(msg)
  })

  it('wraps assistant string content into text block array', () => {
    const msg: Message = { role: 'assistant', content: 'I can help.' }
    expect(normalizeMessage(msg)).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'I can help.' }],
    })
  })

  it('preserves assistant message with tool_use blocks', () => {
    const msg: Message = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'foo.ts' } },
      ],
    }
    expect(normalizeMessage(msg)).toEqual(msg)
  })
})

describe('normalizeMessages', () => {
  it('normalizes multiple messages', () => {
    const msgs: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]
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
