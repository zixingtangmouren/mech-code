import type { UserContentBlock, AssistantContentBlock } from '@mech-code/shared'
import type { InternalMessage } from '../../message/types.js'
import type { MessageSerializer, SerializeOptions } from '../types.js'

// === Anthropic API 请求体类型 ===

export interface AnthropicRequest {
  model: string
  max_tokens: number
  messages: AnthropicMessage[]
  system?: string
  tools?: AnthropicTool[]
  temperature?: number
  top_p?: number
  stop_sequences?: string[]
  stream?: boolean
  thinking?: { type: 'enabled'; budget_tokens: number }
}

type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: AnthropicContentBlock[]
}

/** tool_result 内部可嵌套的 content block */
type AnthropicToolResultContent =
  | { type: 'text'; text: string }
  | { type: 'image'; source: AnthropicImageSource }

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | {
      type: 'tool_result'
      tool_use_id: string
      content: string | AnthropicToolResultContent[]
      is_error?: boolean
    }
  | { type: 'image'; source: AnthropicImageSource }

type AnthropicImageSource =
  | { type: 'base64'; media_type: string; data: string }
  | { type: 'url'; url: string }

type AnthropicTool = {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

// === Anthropic 消息序列化器 ===

export class AnthropicSerializer implements MessageSerializer<AnthropicRequest> {
  constructor(
    private readonly model: string,
    private readonly defaultMaxTokens = 8192,
  ) {}

  serialize(messages: InternalMessage[], options: SerializeOptions): AnthropicRequest {
    const { system, tools, modelParams } = options

    const result: AnthropicRequest = {
      model: this.model,
      max_tokens: modelParams?.maxTokens ?? this.defaultMaxTokens,
      messages: this.convertMessages(messages),
    }

    if (system) result.system = system

    if (tools && tools.length > 0) {
      result.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }))
    }

    if (modelParams?.temperature !== undefined) result.temperature = modelParams.temperature
    if (modelParams?.topP !== undefined) result.top_p = modelParams.topP
    if (modelParams?.stopSequences) result.stop_sequences = modelParams.stopSequences

    // extended thinking 通过 extra.thinking 传入
    const thinking = modelParams?.extra?.['thinking'] as
      | { type: 'enabled'; budget_tokens: number }
      | undefined
    if (thinking) result.thinking = thinking

    return result
  }

  private convertMessages(messages: InternalMessage[]): AnthropicMessage[] {
    const result: AnthropicMessage[] = []

    for (const msg of messages) {
      if (msg.role === 'system') continue // 系统消息已在 system 字段处理

      if (msg.role === 'user') {
        result.push({
          role: 'user',
          content: msg.content.flatMap((b) => this.convertUserBlock(b)),
        })
      } else if (msg.role === 'assistant') {
        const content = msg.content.flatMap((b) => this.convertAssistantBlock(b))
        result.push({ role: 'assistant', content })
      } else if (msg.role === 'tool') {
        // tool 消息 → Anthropic user 消息 with tool_result block
        // 连续的 tool 消息合并到同一个 user 消息中
        let toolResultContent: string | AnthropicToolResultContent[] = msg.content
        // 图片工具结果：生成多模态 content block
        if (msg._imageData) {
          toolResultContent = [
            { type: 'text', text: msg.content },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: msg._imageData.mediaType,
                data: msg._imageData.base64,
              },
            },
          ]
        }
        const toolResultBlock: AnthropicContentBlock = {
          type: 'tool_result',
          tool_use_id: msg.toolCallId,
          content: toolResultContent,
        }
        const last = result[result.length - 1]
        if (last?.role === 'user' && last.content.some((b) => b.type === 'tool_result')) {
          last.content.push(toolResultBlock)
        } else {
          result.push({ role: 'user', content: [toolResultBlock] })
        }
      }
    }

    return result
  }

  private convertUserBlock(block: UserContentBlock): AnthropicContentBlock[] {
    if (block.type === 'text') {
      return [{ type: 'text', text: block.text }]
    }
    if (block.type === 'image') {
      if (block.source.type === 'base64') {
        return [
          {
            type: 'image',
            source: { type: 'base64', media_type: block.source.mediaType, data: block.source.data },
          },
        ]
      }
      if (block.source.type === 'url') {
        return [{ type: 'image', source: { type: 'url', url: block.source.url } }]
      }
    }
    // file 类型暂不支持
    return []
  }

  private convertAssistantBlock(block: AssistantContentBlock): AnthropicContentBlock[] {
    if (block.type === 'text') return [{ type: 'text', text: block.text }]
    if (block.type === 'tool_use') {
      return [{ type: 'tool_use', id: block.id, name: block.name, input: block.input }]
    }
    // thinking 块需要 signature 才能发回 API；我们不保存 signature，暂时跳过
    return []
  }
}
