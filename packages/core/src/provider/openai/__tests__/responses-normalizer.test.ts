import { describe, expect, it } from 'vitest'
import { OpenAIResponsesStreamNormalizer } from '../responses-normalizer.js'

describe('OpenAIResponsesStreamNormalizer', () => {
  it('normalizes text stream events and usage', () => {
    const normalizer = new OpenAIResponsesStreamNormalizer()

    expect(normalizer.push({ type: 'response.output_text.delta', delta: 'Hello' })).toEqual([
      { type: 'text_start' },
      { type: 'text_delta', delta: 'Hello' },
    ])
    expect(normalizer.push({ type: 'response.output_text.delta', delta: ' world' })).toEqual([
      { type: 'text_delta', delta: ' world' },
    ])
    expect(
      normalizer.push({
        type: 'response.completed',
        response: {
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello world' }] }],
          usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        },
      }),
    ).toEqual([])

    expect(normalizer.flush()).toEqual([{ type: 'text_end', fullText: 'Hello world' }])
    expect(normalizer.getStreamMeta()).toEqual({
      usage: { inputTokens: 3, outputTokens: 2 },
      stopReason: 'end_turn',
    })
  })

  it('normalizes function call stream events', () => {
    const normalizer = new OpenAIResponsesStreamNormalizer()

    expect(
      normalizer.push({
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', call_id: 'call_1', name: 'read_file' },
      }),
    ).toEqual([{ type: 'tool_start', toolCallId: 'call_1', toolName: 'read_file' }])
    expect(
      normalizer.push({
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: '{"path":"',
      }),
    ).toEqual([{ type: 'tool_input_delta', toolCallId: 'call_1', delta: '{"path":"' }])
    expect(
      normalizer.push({
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: 'foo.ts"}',
      }),
    ).toEqual([{ type: 'tool_input_delta', toolCallId: 'call_1', delta: 'foo.ts"}' }])
    expect(
      normalizer.push({
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'function_call', call_id: 'call_1', name: 'read_file' },
      }),
    ).toEqual([{ type: 'tool_end', toolCallId: 'call_1' }])
    normalizer.push({
      type: 'response.completed',
      response: {
        output: [{ type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{}' }],
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      },
    })

    expect(normalizer.flush()).toEqual([])
    expect(normalizer.getStreamMeta()).toEqual({
      usage: { inputTokens: 10, outputTokens: 4 },
      stopReason: 'tool_use',
    })
  })

  it('normalizes reasoning summary stream events', () => {
    const normalizer = new OpenAIResponsesStreamNormalizer()

    expect(
      normalizer.push({ type: 'response.reasoning_summary_text.delta', delta: 'Check inputs.' }),
    ).toEqual([{ type: 'reasoning_start' }, { type: 'reasoning_content', text: 'Check inputs.' }])
    expect(
      normalizer.push({ type: 'response.reasoning_summary_text.delta', delta: ' Then answer.' }),
    ).toEqual([{ type: 'reasoning_content', text: ' Then answer.' }])

    expect(normalizer.flush()).toEqual([
      { type: 'reasoning_end', fullText: 'Check inputs. Then answer.' },
    ])
  })
})
