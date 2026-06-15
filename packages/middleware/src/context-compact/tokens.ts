import { estimateMessagesTokens } from '@mech-code/core'
import type { AgentMessage, RunContext } from '@mech-code/core'
import type { ContextCompactMiddlewareOptions } from './types.js'

export function countTokens(
  messages: AgentMessage[],
  ctx: RunContext,
  options: ContextCompactMiddlewareOptions,
): number {
  return options.tokenCounter?.(messages, ctx) ?? estimateMessagesTokens(messages)
}

export function resolveContextWindow(
  ctx: RunContext,
  options: ContextCompactMiddlewareOptions,
): number | undefined {
  if (typeof options.modelContextWindow === 'function') return options.modelContextWindow(ctx)
  return options.modelContextWindow
}
