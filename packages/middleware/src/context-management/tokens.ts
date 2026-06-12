import { estimateMessagesTokens } from '@mech-code/core'
import type { AgentMessage, RunContext } from '@mech-code/core'
import type { ContextManagementMiddlewareOptions } from './types.js'

export function countTokens(
  messages: AgentMessage[],
  ctx: RunContext,
  options: ContextManagementMiddlewareOptions,
): number {
  return options.tokenCounter
    ? options.tokenCounter(messages, ctx)
    : estimateMessagesTokens(messages)
}

export function resolveContextWindow(
  ctx: RunContext,
  options: ContextManagementMiddlewareOptions,
): number | undefined {
  if (typeof options.modelContextWindow === 'function') return options.modelContextWindow(ctx)
  return options.modelContextWindow
}
