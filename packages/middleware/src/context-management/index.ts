import { createMiddleware } from '@mech-code/core'
import type { AgentMiddleware } from '@mech-code/core'
import { applyToolResultCleanup } from './cleanup.js'
import { compactContext, shouldCompact } from './compact.js'
import {
  DEFAULT_KEEP,
  resolveCleanupOptions,
  resolveReactiveOptions,
  resolveToolResultOptions,
} from './defaults.js'
import { callModelWithReactiveCompact } from './reactive.js'
import {
  createDefaultState,
  ensureContextManagementState,
  getContextManagementState,
} from './state.js'
import { CONTEXT_MANAGEMENT_STATE_KEY, type ContextManagementMiddlewareOptions } from './types.js'
import { recordToolOutputBudget, recordUnmanagedToolMessageBudgets } from './tool-results.js'

export {
  CONTEXT_MANAGEMENT_STATE_KEY,
  type ContextManagementMiddlewareOptions,
  type ContextManagementState,
  type ContextSummaryRecord,
  type ContextTrigger,
  type KeepStrategy,
  type ReactiveCompactOptions,
  type StoredToolResultRecord,
  type SummaryOptions,
  type SummarySource,
  type SummarySourceResult,
  type TokenCounter,
  type ToolResultBudgetOptions,
  type ToolResultCleanupOptions,
  type ToolResultStorageOptions,
} from './types.js'

export function contextManagementMiddleware(
  options: ContextManagementMiddlewareOptions = {},
): AgentMiddleware {
  const toolResultOptions = resolveToolResultOptions(options.toolResults)
  const cleanupOptions = resolveCleanupOptions(options.cleanup)
  const reactiveOptions = resolveReactiveOptions(options.reactiveCompact)

  return createMiddleware({
    name: 'context-management',
    state: { [CONTEXT_MANAGEMENT_STATE_KEY]: createDefaultState() },
    beforeAgent(ctx) {
      ensureContextManagementState(ctx.state)
    },
    async beforeModel(ctx) {
      const contextState = getContextManagementState(ctx.state)
      await recordUnmanagedToolMessageBudgets(ctx, contextState, toolResultOptions)
      applyToolResultCleanup(ctx, contextState, options, cleanupOptions)

      if (shouldCompact(ctx, options, contextState, cleanupOptions)) {
        await compactContext(
          ctx,
          options,
          {
            source: 'auto_compact',
            keep: options.keep ?? DEFAULT_KEEP,
          },
          cleanupOptions,
        )
      }
    },
    async wrapToolCall(request, handler) {
      const output = await handler(request)
      return recordToolOutputBudget(
        request.context,
        request.toolCallId,
        request.toolName,
        output,
        toolResultOptions,
      )
    },
    async wrapModelCall(request, handler) {
      return callModelWithReactiveCompact(
        request,
        handler,
        options,
        reactiveOptions,
        cleanupOptions,
      )
    },
  })
}
