import { describe, expect, it } from 'vitest'
import { AssistantMessage, ToolMessage, UserMessage } from '../../../message/message.js'
import { AnthropicSerializer } from '../serializer.js'

describe('AnthropicSerializer', () => {
  it('serializes canonical messages and tool result images', () => {
    const serializer = new AnthropicSerializer('claude-test')
    const request = serializer.serialize(
      [
        new UserMessage('hello'),
        new AssistantMessage([
          { type: 'tool_use', id: 'call_1', name: 'read_image', input: { path: 'image.png' } },
        ]),
        new ToolMessage('call_1', 'read_image', 'image result', {
          image: { type: 'base64', mediaType: 'image/png', data: 'abc' },
        }),
      ],
      {},
    )

    expect(request.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_1', name: 'read_image', input: { path: 'image.png' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: [
              { type: 'text', text: 'image result' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'abc' },
              },
            ],
          },
        ],
      },
    ])
  })
})
