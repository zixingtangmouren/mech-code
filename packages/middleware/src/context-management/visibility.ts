import type { AgentMessage, AssistantContentBlock } from '@mech-code/core'

export interface VisibleEntry {
  index: number
  message: AgentMessage
}

export type ToolVisibleEntry = VisibleEntry & {
  message: Extract<VisibleEntry['message'], { role: 'tool' }>
}

export function getVisibleMessages(messages: AgentMessage[]): AgentMessage[] {
  return getVisibleEntries(messages).map((entry) => entry.message)
}

export function getVisibleEntries(messages: AgentMessage[]): VisibleEntry[] {
  const result: VisibleEntry[] = []
  for (const [index, message] of messages.entries()) {
    if (!isContextCompressed(message.metadata)) {
      result.push({ index, message })
    }
  }
  return result
}

export function isToolEntry(entry: VisibleEntry): entry is ToolVisibleEntry {
  return entry.message.role === 'tool'
}

export function getToolUseIds(content: string | AssistantContentBlock[]): string[] {
  if (!Array.isArray(content)) return []
  return content.flatMap((block) => (block.type === 'tool_use' ? [block.id] : []))
}

export function readContextManagementMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const value = metadata.contextManagement
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function isContextCompressed(metadata: Record<string, unknown>): boolean {
  return readContextManagementMetadata(metadata).compressed === true
}
