import type { RunContext } from '@mech-code/core'
import { estimateTokens } from '@mech-code/core'
import { projectToolResultMessages } from './projection.js'
import { countTokens } from './tokens.js'
import {
  CONTEXT_MANAGEMENT_STATE_KEY,
  type ContextManagementMiddlewareOptions,
  type ContextManagementState,
  type ResolvedToolResultCleanupOptions,
} from './types.js'
import { getVisibleEntries, getVisibleMessages, isToolEntry } from './visibility.js'

export function applyToolResultCleanup(
  ctx: RunContext,
  state: ContextManagementState,
  options: ContextManagementMiddlewareOptions,
  cleanup: ResolvedToolResultCleanupOptions,
): void {
  if (!cleanup.enabled) return
  if (!shouldCleanup(ctx, state, options, cleanup)) return

  const toolMessages = getVisibleEntries(ctx.state.messages).filter(isToolEntry)
  const keepIds = new Set(
    toolMessages
      .slice(Math.max(toolMessages.length - cleanup.keepRecentToolResults, 0))
      .map((entry) => entry.message.toolCallId),
  )
  let cleared = 0

  for (const entry of toolMessages) {
    if (keepIds.has(entry.message.toolCallId)) continue
    if (state.toolResults[entry.message.toolCallId]?.cleared) continue
    const originalEstimatedTokens = estimateTokens(entry.message.content)
    state.toolResults[entry.message.toolCallId] ??= {
      toolCallId: entry.message.toolCallId,
      toolName: entry.message.toolName,
      originalChars: entry.message.content.length,
      originalEstimatedTokens,
      preview: '',
      createdAt: Date.now(),
    }
    state.toolResults[entry.message.toolCallId]!.cleared = true
    cleared++
  }

  if (cleared > 0) {
    state.cleanup = {
      lastCleanupAt: Date.now(),
      lastCleanupTurn: ctx.loopState.turnIndex,
      clearedToolResultCount: (state.cleanup.clearedToolResultCount ?? 0) + cleared,
    }
    ctx.runtime.notifyStateChanged('context_management_cleanup', [CONTEXT_MANAGEMENT_STATE_KEY])
  }
}

function shouldCleanup(
  ctx: RunContext,
  state: ContextManagementState,
  options: ContextManagementMiddlewareOptions,
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
    const tokens = countTokens(
      projectToolResultMessages(getVisibleMessages(ctx.state.messages), state, cleanup),
      ctx,
      options,
    )
    if (tokens >= trigger.tokens) return true
  }

  if (trigger.idleMinutes !== undefined && state.cleanup.lastCleanupAt !== undefined) {
    const elapsedMs = Date.now() - state.cleanup.lastCleanupAt
    if (elapsedMs >= trigger.idleMinutes * 60_000) return true
  }

  return false
}
