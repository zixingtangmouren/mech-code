import type { AgentMessage } from '@mech-code/core'

export function getToolMessages(
  messages: AgentMessage[],
): Array<Extract<AgentMessage, { role: 'tool' }>> {
  return messages.filter((message): message is Extract<AgentMessage, { role: 'tool' }> => {
    return message.role === 'tool'
  })
}
