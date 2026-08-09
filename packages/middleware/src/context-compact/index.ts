import { createMiddleware } from '@mech-code/core'
import type { AgentMiddleware } from '@mech-code/core'
import { shouldCompact, compactContext } from './compact.js'
import { resolveReactiveOptions } from './defaults.js'
import { callModelWithReactiveCompact, withVisibleStateMessages } from './reactive.js'
import { createContextCompactState, ensureContextCompactState } from './state.js'
import { CONTEXT_COMPACT_STATE_KEY, type ContextCompactMiddlewareOptions } from './types.js'

export {
  CONTEXT_COMPACT_STATE_KEY,
  CONTEXT_COMPACT_EVENT_SOURCE,
  isContextCompactEvent,
  type ContextCompactCompletedEvent,
  type ContextCompactEvent,
  type ContextCompactFailedEvent,
  type ContextCompactMode,
  type ContextCompactMiddlewareOptions,
  type ContextCompactStartedEvent,
  type ContextCompactState,
  type ContextSummaryRecord,
  type ContextTrigger,
  type ReactiveCompactOptions,
  type SummaryOptions,
  type SummarySource,
  type SummarySourceResult,
  type TokenCounter,
} from './types.js'

export function contextCompactMiddleware(
  options: ContextCompactMiddlewareOptions = {},
): AgentMiddleware {
  const reactive = resolveReactiveOptions(options.reactiveCompact)

  return createMiddleware({
    name: 'context-compact',
    state: { [CONTEXT_COMPACT_STATE_KEY]: createContextCompactState() },
    beforeAgent(ctx) {
      ensureContextCompactState(ctx.state)
    },
    async wrapModelCall(request, handler) {
      let currentRequest = request
      if (shouldCompact(request.context, request.params.messages, options)) {
        const compacted = await compactContext(request.context, request.params.messages, options, {
          source: 'auto_compact',
        })
        if (compacted) currentRequest = withVisibleStateMessages(request)
      }

      return callModelWithReactiveCompact(currentRequest, handler, options, reactive)
    },
  })
}
