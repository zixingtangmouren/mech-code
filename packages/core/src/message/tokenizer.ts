import type { InternalMessage } from './types.js'

/**
 * 对原始字符串进行 token 数量的近似估算。
 * 启发式规则：英文约 4 字符/token，中日韩字符约 2 字符/token。
 * 如需生产级精度，请集成 tiktoken 或对应 Provider 的分词器。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** 估算单条 InternalMessage 的 token 数量 */
export function estimateMessageTokens(msg: InternalMessage): number {
  // 每条消息的固定开销（角色标识 + 格式化）
  const overhead = 4

  switch (msg.role) {
    case 'system':
    case 'tool':
      return overhead + estimateTokens(msg.content)

    case 'user':
      return (
        overhead +
        msg.content.reduce((sum, block) => {
          if (block.type === 'text') return sum + estimateTokens(block.text)
          if (block.type === 'image') return sum + 1024 // 图片 token 保守估算
          return sum
        }, 0)
      )

    case 'assistant':
      return (
        overhead +
        msg.content.reduce((sum, block) => {
          if (block.type === 'text' || block.type === 'thinking') {
            return sum + estimateTokens(block.text)
          }
          if (block.type === 'tool_use') {
            return sum + estimateTokens(block.name) + estimateTokens(JSON.stringify(block.input))
          }
          return sum
        }, 0)
      )
  }
}

/** 估算消息数组的总 token 数量 */
export function estimateMessagesTokens(msgs: InternalMessage[]): number {
  return msgs.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0)
}
