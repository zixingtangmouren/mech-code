import { estimateMessagesTokens, estimateTokens } from '@mech-code/core'
import type { RunContext } from '@mech-code/core'
import { projectToolResultMessages } from './projection.js'
import {
  TOOL_RESULT_STATE_KEY,
  type ResolvedToolResultCleanupOptions,
  type ToolResultState,
} from './types.js'
import { getToolMessages } from './visibility.js'

export function applyToolResultCleanup(
  ctx: RunContext,
  state: ToolResultState,
  cleanup: ResolvedToolResultCleanupOptions,
): void {
  if (!cleanup.enabled || !shouldCleanup(ctx, state, cleanup)) return

  const toolMessages = getToolMessages(ctx.state.messages)
  const keepIds = new Set(
    toolMessages
      .slice(Math.max(toolMessages.length - cleanup.keepRecentToolResults, 0))
      .map((message) => message.toolCallId),
  )
  let cleared = 0

  for (const message of toolMessages) {
    if (keepIds.has(message.toolCallId)) continue
    if (state.records[message.toolCallId]?.cleared) continue

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
    lastCleanupTurn: ctx.loopState.turnIndex,
    clearedToolResultCount: (state.cleanup.clearedToolResultCount ?? 0) + cleared,
  }
  ctx.runtime.notifyStateChanged('tool_result_cleanup', [TOOL_RESULT_STATE_KEY])
}

function shouldCleanup(
  ctx: RunContext,
  state: ToolResultState,
  cleanup: ResolvedToolResultCleanupOptions,
): boolean {
  const trigger = cleanup.trigger

  if (
    trigger.turns !== undefined &&
    ctx.loopState.turnIndex - (state.cleanup.lastCleanupTurn ?? -1) >= trigger.turns
  ) {
    return true
  }

  if (trigger.tokens !== undefined) {
    const projected = projectToolResultMessages(ctx.state.messages, state, cleanup)
    if (estimateMessagesTokens(projected) >= trigger.tokens) return true
  }

  if (trigger.idleMinutes !== undefined && state.cleanup.lastCleanupAt !== undefined) {
    const elapsedMs = Date.now() - state.cleanup.lastCleanupAt
    if (elapsedMs >= trigger.idleMinutes * 60_000) return true
  }

  return false
}
