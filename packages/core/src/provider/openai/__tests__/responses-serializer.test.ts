import { describe, expect, it } from 'vitest'
import { OpenAIResponsesSerializer } from '../responses-serializer.js'
import type { AgentMessage } from '../../../message/message.js'
import {
  AssistantMessage,
  SystemMessage,
  ToolMessage,
  UserMessage,
} from '../../../message/message.js'
import type { ToolDefinition } from '@mech-code/shared'

describe('OpenAIResponsesSerializer', () => {
  it('serializes instructions, multimodal input, tools, and model params', () => {
    const serializer = new OpenAIResponsesSerializer('gpt-5')
    const tools: ToolDefinition[] = [
      {
        name: 'read_file',
        description: 'Read a file',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ]
    const messages: AgentMessage[] = [
      new SystemMessage('Use concise answers.'),
      new UserMessage([
        { type: 'text', text: 'Look at this' },
        { type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } },
      ]),
    ]

    const body = serializer.serialize(messages, {
      system: 'You are helpful.',
      tools,
      modelParams: {
        maxTokens: 1000,
        temperature: 0.2,
        topP: 0.9,
        stopSequences: ['STOP'],
        extra: { metadata: { traceId: 'trace_1' } },
      },
    })

    expect(body).toEqual({
      model: 'gpt-5',
      instructions: 'You are helpful.\n\nUse concise answers.',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Look at this' },
            { type: 'input_image', image_url: 'https://example.com/image.png' },
          ],
        },
      ],
      tools: [
        {
          type: 'function',
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
      max_output_tokens: 1000,
      temperature: 0.2,
      top_p: 0.9,
      stop: ['STOP'],
      metadata: { traceId: 'trace_1' },
    })
  })

  it('serializes assistant history and tool results as response input items', () => {
    const serializer = new OpenAIResponsesSerializer('gpt-5')
    const messages: AgentMessage[] = [
      new AssistantMessage([
        { type: 'text', text: 'I will read it.' },
        { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'foo.ts' } },
      ]),
      new ToolMessage('call_1', 'read_file', 'file contents'),
    ]

    const body = serializer.serialize(messages, {})

    expect(body.input).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'output_text', text: 'I will read it.' }],
      },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'read_file',
        arguments: '{"path":"foo.ts"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'file contents',
      },
    ])
  })
})
