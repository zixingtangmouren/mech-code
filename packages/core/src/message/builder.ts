import type { ToolDefinition } from '@mech-code/shared'
import type { ChatParams } from '../provider/types.js'
import type { AgentMessage } from './message.js'
import { deserializeAgentMessage, serializeAgentMessage } from './message.js'

/**
 * 将 AgentMessages、系统提示词和工具定义组装为 ChatParams，
 * 以便传递给任意 LLMProvider。
 *
 * params.messages 是本次 provider 调用投影；这里深拷贝消息，避免 wrapper
 * 对 request.params 的临时改写污染真实 state.messages。
 */
export function buildChatParams(options: {
  messages: AgentMessage[]
  system?: string
  tools?: ToolDefinition[]
}): ChatParams {
  return {
    messages: options.messages.map(cloneAgentMessage),
    system: options.system,
    tools: options.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }
}

function cloneAgentMessage(message: AgentMessage): AgentMessage {
  return deserializeAgentMessage(structuredClone(serializeAgentMessage(message)))
}
