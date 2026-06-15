import { createMiddleware } from '@mech-code/core'
import type { AgentMiddleware } from '@mech-code/core'
import { applyToolResultCleanup } from './cleanup.js'
import { resolveBudgetOptions, resolveCleanupOptions } from './defaults.js'
import { projectToolResultMessages } from './projection.js'
import { recordToolOutputBudget, recordUnmanagedToolMessageBudgets } from './records.js'
import { createToolResultState, ensureToolResultState, getToolResultState } from './state.js'
import { TOOL_RESULT_STATE_KEY, type ToolResultMiddlewareOptions } from './types.js'

export {
  TOOL_RESULT_STATE_KEY,
  type StoredToolResultRecord,
  type ToolResultBudgetOptions,
  type ToolResultCleanupOptions,
  type ToolResultMiddlewareOptions,
  type ToolResultState,
  type ToolResultStorageOptions,
} from './types.js'

export function toolResultMiddleware(options: ToolResultMiddlewareOptions = {}): AgentMiddleware {
  const budget = resolveBudgetOptions(options)
  const cleanup = resolveCleanupOptions(options.cleanup)

  return createMiddleware({
    name: 'tool-result',
    state: { [TOOL_RESULT_STATE_KEY]: createToolResultState() },
    beforeAgent(ctx) {
      ensureToolResultState(ctx.state)
    },
    async beforeModel(ctx) {
      const state = getToolResultState(ctx.state)
      await recordUnmanagedToolMessageBudgets(ctx, state, budget)
      applyToolResultCleanup(ctx, state, cleanup)
    },
    async wrapToolCall(request, handler) {
      const output = await handler(request)
      return recordToolOutputBudget(
        request.context,
        request.toolCallId,
        request.toolName,
        output,
        budget,
      )
    },
    wrapModelCall(request, handler) {
      const state = getToolResultState(request.context.state)
      return handler({
        ...request,
        params: {
          ...request.params,
          messages: projectToolResultMessages(request.params.messages, state, cleanup),
        },
      })
    },
  })
}
