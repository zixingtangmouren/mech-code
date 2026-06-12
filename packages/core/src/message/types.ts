import type { UserContentBlock, AssistantContentBlock } from '@mech-code/shared'

export type { UserContentBlock, AssistantContentBlock }

/**
 * InternalMessage —— Provider 序列化阶段的内部规范化类型。
 * Agent Loop、middleware 和 LLMProvider 的公开入参使用 AgentMessage。
 * Provider serializer 在内部把 AgentMessage 转成此类型，再转成厂商请求体。
 */
export type InternalMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: UserContentBlock[] }
  | { role: 'assistant'; content: AssistantContentBlock[] }
  | {
      role: 'tool'
      toolCallId: string
      toolName?: string
      content: string
      _imageData?: { base64: string; mediaType: string }
    }
