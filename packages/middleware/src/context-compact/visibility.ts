import type { AgentMessage } from '@mech-code/core'

export interface VisibleEntry {
  index: number
  message: AgentMessage
}

export function getVisibleEntries(messages: AgentMessage[]): VisibleEntry[] {
  const entries: VisibleEntry[] = []
  messages.forEach((message, index) => {
    if (!isCompressed(message.metadata)) entries.push({ index, message })
  })
  return entries
}

export function getVisibleMessages(messages: AgentMessage[]): AgentMessage[] {
  return getVisibleEntries(messages).map((entry) => entry.message)
}

export function readContextCompactMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const value = metadata.contextCompact
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function isCompressed(metadata: Record<string, unknown>): boolean {
  return readContextCompactMetadata(metadata).compressed === true
}
