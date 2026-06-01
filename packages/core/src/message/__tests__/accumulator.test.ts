import { describe, expect, it } from 'vitest'
import { MessageAccumulator } from '../accumulator.js'
import type { AgentEvent } from '@mech-code/shared'

describe('MessageAccumulator', () => {
  it('accumulates text events into assistant message', () => {
    const acc = new MessageAccumulator()
    const events: AgentEvent[] = [
      { type: 'text_start' },
      { type: 'text_delta', delta: 'Hello' },
      { type: 'text_delta', delta: ', world!' },
    ]
    for (const e of events) acc.push(e)
    const msg = acc.flush()
    expect(msg).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello, world!' }],
    })
  })

  it('accumulates reasoning (thinking) events', () => {
    const acc = new MessageAccumulator()
    acc.push({ type: 'reasoning_start' })
    acc.push({ type: 'reasoning_content', text: 'Let me think...' })
    acc.push({ type: 'text_start' })
    acc.push({ type: 'text_delta', delta: 'The answer is 42.' })
    const msg = acc.flush()
    expect(msg.role).toBe('assistant')
    expect(msg.content).toEqual([
      { type: 'thinking', text: 'Let me think...' },
      { type: 'text', text: 'The answer is 42.' },
    ])
  })

  it('accumulates tool_use events and parses JSON input', () => {
    const acc = new MessageAccumulator()
    acc.push({ type: 'tool_start', toolCallId: 'call_1', toolName: 'read_file' })
    acc.push({ type: 'tool_input_delta', delta: '{"path":' } as AgentEvent)
    acc.push({ type: 'tool_input_delta', delta: '"foo.ts"}' } as AgentEvent)
    const msg = acc.flush()
    expect(msg.content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'foo.ts' } },
    ])
  })

  it('hasToolUse returns true when tool_use block exists', () => {
    const acc = new MessageAccumulator()
    expect(acc.hasToolUse()).toBe(false)
    acc.push({ type: 'tool_start', toolCallId: 'c1', toolName: 'search' })
    expect(acc.hasToolUse()).toBe(true)
  })

  it('reset clears accumulated state', () => {
    const acc = new MessageAccumulator()
    acc.push({ type: 'text_start' })
    acc.push({ type: 'text_delta', delta: 'some text' })
    acc.reset()
    const msg = acc.flush()
    expect(msg.content).toEqual([])
  })
})
