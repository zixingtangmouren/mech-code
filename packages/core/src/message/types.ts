import type { UserContentBlock, AssistantContentBlock } from '@mech/shared'

export type { UserContentBlock, AssistantContentBlock }

/**
 * InternalMessage —— Agent Loop 运行时类型。
 * 所有 content 字段均已规范化为数组（不使用字符串简写）。
 * Loop Engine 只操作此类型，不直接处理外部 Message 类型。
 */
export type InternalMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: UserContentBlock[] }
  | { role: 'assistant'; content: AssistantContentBlock[] }
  | {
      role: 'tool'
      toolCallId: string
      content: string
      _imageData?: { base64: string; mediaType: string }
    }
