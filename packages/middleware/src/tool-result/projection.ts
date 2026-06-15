import { ToolMessage } from '@mech-code/core'
import type { AgentMessage } from '@mech-code/core'
import { renderToolPreview } from './records.js'
import type { ResolvedToolResultCleanupOptions, ToolResultState } from './types.js'

export function projectToolResultMessages(
  messages: AgentMessage[],
  state: ToolResultState,
  cleanup: ResolvedToolResultCleanupOptions,
): AgentMessage[] {
  return messages.map((message) => {
    if (message.role !== 'tool') return message

    const content = projectToolResultContent(message, state, cleanup)
    if (content === message.content) return message

    return new ToolMessage(message.toolCallId, message.toolName, content, {
      metadata: message.metadata,
    })
  })
}

function projectToolResultContent(
  message: Extract<AgentMessage, { role: 'tool' }>,
  state: ToolResultState,
  cleanup: ResolvedToolResultCleanupOptions,
): string {
  const record = state.records[message.toolCallId]
  if (!record) return message.content
  if (record.cleared) return cleanup.replacementText
  return renderToolPreview(record)
}
