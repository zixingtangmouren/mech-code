import type { ToolDefinition } from '@mech/shared'
import type { ChatParams } from '../provider/types.js'
import type { InternalMessage } from './types.js'

/**
 * 将 InternalMessages、系统提示词和工具定义组装为 ChatParams，
 * 以便传递给任意 LLMProvider。
 */
export function buildChatParams(options: {
  messages: InternalMessage[]
  system?: string
  tools?: ToolDefinition[]
}): ChatParams {
  return {
    messages: options.messages,
    system: options.system,
    tools: options.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }
}
