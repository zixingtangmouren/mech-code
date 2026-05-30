import type { Message } from '@mech/shared'
import type { InternalMessage } from './types.js'

/**
 * 将单条外部 Message 规范化为 InternalMessage。
 * - 字符串内容 → 包装为 [{ type: 'text', text }]
 * - 数组内容 → 原样使用
 */
export function normalizeMessage(msg: Message): InternalMessage {
  switch (msg.role) {
    case 'system':
    case 'tool':
      return msg

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
  }
}

/** 将外部 Message 数组批量规范化为 InternalMessage 数组 */
export function normalizeMessages(msgs: Message[]): InternalMessage[] {
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
