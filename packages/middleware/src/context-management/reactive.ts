import { ProviderError, retryStreamResult } from '@mech-code/core'
import type { ChatParams, ModelCallHandler, ModelCallRequest, StreamResult } from '@mech-code/core'
import { compactContext } from './compact.js'
import { getProviderVisibleMessages } from './projection.js'
import { getContextManagementState } from './state.js'
import type {
  ContextManagementMiddlewareOptions,
  ResolvedReactiveCompactOptions,
  ResolvedToolResultCleanupOptions,
} from './types.js'

export async function callModelWithReactiveCompact(
  request: ModelCallRequest,
  handler: ModelCallHandler,
  options: ContextManagementMiddlewareOptions,
  reactive: ResolvedReactiveCompactOptions,
  cleanup: ResolvedToolResultCleanupOptions,
): Promise<StreamResult> {
  let attempts = 0

  const retry = async (error: unknown): Promise<StreamResult | null> => {
    if (!shouldReactiveCompact(error, reactive, attempts)) return null
    attempts++
    const compacted = await compactContext(
      request.context,
      options,
      {
        source: 'reactive_compact',
        keep: reactive.fallbackKeep,
      },
      cleanup,
    )
    if (!compacted) return null
    return handler(withProviderVisibleMessages(request, cleanup))
  }

  try {
    const result = await handler(withProviderVisibleMessages(request, cleanup))
    return retryStreamResult(result, ({ error }) => retry(error))
  } catch (error) {
    const retryResult = await retry(error)
    if (!retryResult) throw error
    return retryStreamResult(retryResult, ({ error: retryError }) => retry(retryError))
  }
}

function shouldReactiveCompact(
  error: unknown,
  reactive: ResolvedReactiveCompactOptions,
  attempts: number,
): boolean {
  return (
    reactive.enabled &&
    attempts < reactive.maxRetries &&
    error instanceof ProviderError &&
    error.code === 'context_too_long'
  )
}

function withProviderVisibleMessages(
  request: ModelCallRequest,
  cleanup: ResolvedToolResultCleanupOptions,
): ModelCallRequest {
  const state = getContextManagementState(request.context.state)
  return {
    ...request,
    params: {
      ...request.params,
      messages: getProviderVisibleMessages(request.context, state, cleanup),
    } satisfies ChatParams,
  }
}
