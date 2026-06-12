import { ToolMessage } from '@mech-code/core'
import type { AgentMessage, RunContext } from '@mech-code/core'
import { renderToolPreview } from './tool-results.js'
import type { ContextManagementState, ResolvedToolResultCleanupOptions } from './types.js'
import { getVisibleMessages } from './visibility.js'

export function getProviderVisibleMessages(
  ctx: RunContext,
  state: ContextManagementState,
  cleanup: ResolvedToolResultCleanupOptions,
): AgentMessage[] {
  return projectToolResultMessages(getVisibleMessages(ctx.state.messages), state, cleanup)
}

export function projectToolResultMessages(
  messages: AgentMessage[],
  state: ContextManagementState,
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
  state: ContextManagementState,
  cleanup: ResolvedToolResultCleanupOptions,
): string {
  const record = state.toolResults[message.toolCallId]
  if (!record) return message.content
  if (record.cleared) return cleanup.replacementText
  return renderToolPreview(record)
}
