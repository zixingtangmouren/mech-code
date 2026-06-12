import type { UserContentBlock, AssistantContentBlock } from '@mech-code/shared'
import type { AgentMessage } from '../../message/message.js'
import type { InternalMessage } from '../../message/types.js'
import { normalizeMessages } from '../../message/normalize.js'
import type { MessageSerializer, SerializeOptions } from '../types.js'

// === OpenAI Responses API 请求体类型 ===

export interface OpenAIResponsesRequest {
  model: string
  input: OpenAIResponseInputItem[]
  instructions?: string
  tools?: OpenAIResponsesTool[]
  max_output_tokens?: number
  temperature?: number
  top_p?: number
  stop?: string[]
  stream?: boolean
  [key: string]: unknown
}

type OpenAIResponseInputItem =
  | {
      role: 'user' | 'assistant'
      content: OpenAIResponseMessageContent[]
    }
  | {
      type: 'function_call'
      call_id: string
      name: string
      arguments: string
    }
  | {
      type: 'function_call_output'
      call_id: string
      output: string
    }

type OpenAIResponseMessageContent =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }
  | { type: 'output_text'; text: string }

type OpenAIResponsesTool = {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
}

// === OpenAI Responses 消息序列化器 ===

export class OpenAIResponsesSerializer implements MessageSerializer<OpenAIResponsesRequest> {
  constructor(private readonly model: string) {}

  serialize(messages: AgentMessage[], options: SerializeOptions): OpenAIResponsesRequest {
    const { tools, modelParams } = options
    const internalMessages = normalizeMessages(messages)
    const instructions = this.collectInstructions(options.system, internalMessages)

    const result: OpenAIResponsesRequest = {
      model: this.model,
      input: this.convertInput(internalMessages),
    }

    if (instructions) result.instructions = instructions

    if (tools && tools.length > 0) {
      result.tools = tools.map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      }))
    }

    if (modelParams?.maxTokens !== undefined) result.max_output_tokens = modelParams.maxTokens
    if (modelParams?.temperature !== undefined) result.temperature = modelParams.temperature
    if (modelParams?.topP !== undefined) result.top_p = modelParams.topP
    if (modelParams?.stopSequences) result.stop = modelParams.stopSequences

    if (modelParams?.extra) {
      Object.assign(result, modelParams.extra)
    }

    return result
  }

  private collectInstructions(system: string | undefined, messages: InternalMessage[]): string {
    const parts: string[] = []
    if (system) parts.push(system)
    for (const msg of messages) {
      if (msg.role === 'system') parts.push(msg.content)
    }
    return parts.join('\n\n')
  }

  private convertInput(messages: InternalMessage[]): OpenAIResponseInputItem[] {
    const input: OpenAIResponseInputItem[] = []

    for (const msg of messages) {
      if (msg.role === 'system') continue

      if (msg.role === 'user') {
        input.push({ role: 'user', content: msg.content.flatMap((b) => this.convertUserBlock(b)) })
      } else if (msg.role === 'assistant') {
        input.push(...this.convertAssistantBlocks(msg.content))
      } else if (msg.role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: msg.toolCallId,
          output: msg.content,
        })
      }
    }

    return input
  }

  private convertUserBlock(block: UserContentBlock): OpenAIResponseMessageContent[] {
    if (block.type === 'text') {
      return [{ type: 'input_text', text: block.text }]
    }
    if (block.type === 'image') {
      if (block.source.type === 'base64') {
        return [
          {
            type: 'input_image',
            image_url: `data:${block.source.mediaType};base64,${block.source.data}`,
          },
        ]
      }
      if (block.source.type === 'url') {
        return [{ type: 'input_image', image_url: block.source.url }]
      }
    }
    return []
  }

  private convertAssistantBlocks(blocks: AssistantContentBlock[]): OpenAIResponseInputItem[] {
    const input: OpenAIResponseInputItem[] = []
    const text = blocks
      .filter((b): b is Extract<AssistantContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('')

    if (text) {
      input.push({ role: 'assistant', content: [{ type: 'output_text', text }] })
    }

    for (const block of blocks) {
      if (block.type !== 'tool_use') continue
      input.push({
        type: 'function_call',
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input),
      })
    }

    return input
  }
}
