import type { Message } from '@mech-code/shared'
import type { AgentMessage } from './message.js'
import type { InternalMessage } from './types.js'

/**
 * Provider 序列化 helper：将单条 AgentMessage 规范化为 InternalMessage。
 * - 字符串内容 → 包装为 [{ type: 'text', text }]
 * - 数组内容 → 原样使用
 * - metadata 不会进入 Provider payload；tool 图片数据例外，会转成内部 _imageData 给 serializer。
 */
export function normalizeMessage(msg: AgentMessage): InternalMessage {
  switch (msg.role) {
    case 'system':
      return { role: 'system', content: msg.content }

    case 'tool': {
      const normalized: InternalMessage = {
        role: 'tool',
        toolCallId: msg.toolCallId,
        toolName: msg.toolName,
        content: msg.content,
      }
      const imageData = readImageData(msg.metadata)
      if (imageData) normalized._imageData = imageData
      return normalized
    }

    case 'user':
      return {
        role: 'user',
        content:
          typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : msg.content,
      }

    case 'assistant':
      return {
        role: 'assistant',
        content:
          typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : msg.content,
      }

    default:
      throw new Error(`未知的消息角色: ${(msg as { role: string }).role}`)
  }
}

/** 将 AgentMessage 数组批量规范化为 InternalMessage 数组 */
export function normalizeMessages(msgs: AgentMessage[]): InternalMessage[] {
  return msgs.map(normalizeMessage)
}

/**
 * 将 InternalMessage 反规范化为外部 Message。
 * - 仅含单个文本块的 assistant/user → 简化为字符串
 * - 多块或非文本 → 保持数组形式
 */
export function denormalizeMessage(msg: InternalMessage): Message {
  switch (msg.role) {
    case 'system':
    case 'tool':
      return msg

    case 'user': {
      const blocks = msg.content
      if (blocks.length === 1 && blocks[0]!.type === 'text') {
        return { role: 'user', content: blocks[0]!.text }
      }
      return msg
    }

    case 'assistant': {
      const blocks = msg.content
      const onlyText = blocks.length === 1 && blocks[0]!.type === 'text'
      if (onlyText) {
        return { role: 'assistant', content: (blocks[0] as { type: 'text'; text: string }).text }
      }
      return msg
    }
  }
}

/** 将 InternalMessage 数组批量反规范化为外部 Message 数组 */
export function denormalizeMessages(msgs: InternalMessage[]): Message[] {
  return msgs.map(denormalizeMessage)
}

function readImageData(
  metadata: Record<string, unknown>,
): { base64: string; mediaType: string } | undefined {
  const imageData = metadata.imageData
  if (!imageData || typeof imageData !== 'object' || Array.isArray(imageData)) return undefined
  const record = imageData as Record<string, unknown>
  if (typeof record.base64 !== 'string' || typeof record.mediaType !== 'string') return undefined
  return { base64: record.base64, mediaType: record.mediaType }
}
