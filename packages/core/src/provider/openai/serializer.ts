import type { UserContentBlock, AssistantContentBlock } from '@mech-code/shared'
import type { InternalMessage } from '../../message/types.js'
import type { MessageSerializer, SerializeOptions } from '../types.js'

// === OpenAI API 请求体类型 ===

export interface OpenAIRequest {
  model: string
  messages: OpenAIMessage[]
  tools?: OpenAITool[]
  max_tokens?: number
  temperature?: number
  top_p?: number
  stop?: string[]
  stream?: boolean
  stream_options?: { include_usage: boolean }
}

type OpenAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | OpenAIUserContentBlock[] }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

type OpenAIUserContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

type OpenAIToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

type OpenAITool = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

// === OpenAI 消息序列化器 ===

export class OpenAISerializer implements MessageSerializer<OpenAIRequest> {
  constructor(private readonly model: string) {}

  serialize(messages: InternalMessage[], options: SerializeOptions): OpenAIRequest {
    const { system, tools, modelParams } = options
    const openAIMessages: OpenAIMessage[] = []

    // 系统提示放在消息数组首位
    if (system) {
      openAIMessages.push({ role: 'system', content: system })
    }

    for (const msg of messages) {
      if (msg.role === 'system') {
        // messages 数组中的 system 也追加（追加到已有 system 后）
        openAIMessages.push({ role: 'system', content: msg.content })
      } else if (msg.role === 'user') {
        openAIMessages.push({
          role: 'user',
          content: this.convertUserContent(msg.content),
        })
      } else if (msg.role === 'assistant') {
        openAIMessages.push(this.convertAssistantMessage(msg.content))
      } else if (msg.role === 'tool') {
        openAIMessages.push({
          role: 'tool',
          tool_call_id: msg.toolCallId,
          content: msg.content,
        })
      }
    }

    const result: OpenAIRequest = {
      model: this.model,
      messages: openAIMessages,
    }

    if (tools && tools.length > 0) {
      result.tools = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }))
    }

    if (modelParams?.maxTokens !== undefined) result.max_tokens = modelParams.maxTokens
    if (modelParams?.temperature !== undefined) result.temperature = modelParams.temperature
    if (modelParams?.topP !== undefined) result.top_p = modelParams.topP
    if (modelParams?.stopSequences) result.stop = modelParams.stopSequences

    return result
  }

  private convertUserContent(blocks: UserContentBlock[]): string | OpenAIUserContentBlock[] {
    // 纯文本优化：单个文本块直接返回字符串
    if (blocks.length === 1 && blocks[0]?.type === 'text') {
      return blocks[0].text
    }

    return blocks.flatMap((block): OpenAIUserContentBlock[] => {
      if (block.type === 'text') {
        return [{ type: 'text', text: block.text }]
      }
      if (block.type === 'image') {
        if (block.source.type === 'base64') {
          return [
            {
              type: 'image_url',
              image_url: { url: `data:${block.source.mediaType};base64,${block.source.data}` },
            },
          ]
        }
        if (block.source.type === 'url') {
          return [{ type: 'image_url', image_url: { url: block.source.url } }]
        }
      }
      return []
    })
  }

  private convertAssistantMessage(
    blocks: AssistantContentBlock[],
  ): OpenAIMessage & { role: 'assistant' } {
    const toolCalls: OpenAIToolCall[] = blocks
      .filter(
        (b): b is Extract<AssistantContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
      )
      .map((b) => ({
        id: b.id,
        type: 'function' as const,
        function: { name: b.name, arguments: JSON.stringify(b.input) },
      }))

    // thinking 块无需回传给 OpenAI/DeepSeek API（模型不接受 reasoning 回传）
    const textContent = blocks
      .filter((b): b is Extract<AssistantContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('')

    if (toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: textContent || null,
        tool_calls: toolCalls,
      }
    }

    return { role: 'assistant', content: textContent }
  }
}
