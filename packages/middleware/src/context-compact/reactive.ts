import { ProviderError, retryStreamResult } from '@mech-code/core'
import type { ChatParams, ModelCallHandler, ModelCallRequest, StreamResult } from '@mech-code/core'
import { compactContext } from './compact.js'
import { getVisibleMessages } from './visibility.js'
import type { ContextCompactMiddlewareOptions, ResolvedReactiveCompactOptions } from './types.js'

export async function callModelWithReactiveCompact(
  request: ModelCallRequest,
  handler: ModelCallHandler,
  options: ContextCompactMiddlewareOptions,
  reactive: ResolvedReactiveCompactOptions,
): Promise<StreamResult> {
  let attempts = 0

  const retry = async (error: unknown): Promise<StreamResult | null> => {
    if (!shouldReactiveCompact(error, reactive, attempts)) return null
    attempts++

    const compacted = await compactContext(request.context, request.params.messages, options, {
      source: 'reactive_compact',
    })
    if (!compacted) return null

    return handler(withVisibleStateMessages(request))
  }

  try {
    const result = await handler(request)
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

export function withVisibleStateMessages(request: ModelCallRequest): ModelCallRequest {
  return {
    ...request,
    params: {
      ...request.params,
      messages: getVisibleMessages(request.context.state.messages),
    } satisfies ChatParams,
  }
}
