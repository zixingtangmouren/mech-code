import { estimateTokens } from '@mech-code/core'
import type { RunContext } from '@mech-code/core'
import type { ResolvedToolResultCleanupOptions, ToolResultState } from './types.js'
import { getToolMessages } from './visibility.js'

export function applyToolResultCleanup(
  ctx: RunContext,
  state: ToolResultState,
  cleanup: ResolvedToolResultCleanupOptions,
): void {
  if (cleanup.maxAgeMs === undefined) return

  const toolMessages = getToolMessages(ctx.state.messages)
  const now = Date.now()
  let cleared = 0

  for (const message of toolMessages) {
    if (state.records[message.toolCallId]?.cleared) continue
    const createdAt = readCreatedAt(message.metadata)
    if (createdAt === undefined || now - createdAt < cleanup.maxAgeMs) continue

    state.records[message.toolCallId] ??= {
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      originalChars: message.content.length,
      originalEstimatedTokens: estimateTokens(message.content),
      preview: '',
      createdAt: Date.now(),
    }
    state.records[message.toolCallId]!.cleared = true
    cleared++
  }

  if (cleared === 0) return

  state.cleanup = {
    lastCleanupAt: Date.now(),
    clearedToolResultCount: (state.cleanup.clearedToolResultCount ?? 0) + cleared,
  }
}

function readCreatedAt(metadata: Record<string, unknown>): number | undefined {
  return typeof metadata.createdAt === 'number' ? metadata.createdAt : undefined
}
