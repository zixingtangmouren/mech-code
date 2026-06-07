import type { AgentEvent } from '@mech-code/shared'
import type { ChatResponse, StreamResult, StreamNormalizer } from './types.js'
import { MessageAccumulator } from '../message/accumulator.js'

export interface StreamResultRetryContext {
  error: unknown
  attempt: number
  emittedEvents: number
}

export type StreamResultRetryHandler = (
  context: StreamResultRetryContext,
) => Promise<StreamResult | null> | StreamResult | null

/**
 * createStreamResult — 将厂商原始 chunk 流包装为 StreamResult 双通道。
 *
 * BaseProvider.stream() 调用此函数组装 stream + final + abort：
 * - stream: 将厂商 chunk 经 normalizer 转换后逐 AgentEvent yield
 * - final:  流结束后由 MessageAccumulator + normalizer.getStreamMeta() resolve
 * - abort:  调用 controller.abort() 中止 fetch
 */
export function createStreamResult<TVendorChunk>(options: {
  vendorChunks: AsyncIterable<TVendorChunk>
  normalizer: StreamNormalizer<TVendorChunk>
  controller: AbortController
}): StreamResult {
  const { vendorChunks, normalizer, controller } = options
  const accumulator = new MessageAccumulator()

  let resolveFinale!: (response: ChatResponse) => void
  let rejectFinale!: (error: unknown) => void

  const final = new Promise<ChatResponse>((resolve, reject) => {
    resolveFinale = resolve
    rejectFinale = reject
  })

  async function* generateStream(): AsyncIterable<AgentEvent> {
    try {
      // 处理厂商 chunk 流
      for await (const chunk of vendorChunks) {
        for (const event of normalizer.push(chunk)) {
          accumulator.push(event)
          yield event
        }
      }

      // 刷出 normalizer 中缓冲的剩余事件
      for (const event of normalizer.flush()) {
        accumulator.push(event)
        yield event
      }

      // 从 normalizer 获取 usage 和 stopReason，组装 ChatResponse
      const meta = normalizer.getStreamMeta()
      const msg = accumulator.flush()
      resolveFinale({
        content: msg.role === 'assistant' ? msg.content : [],
        usage: meta.usage,
        stopReason: meta.stopReason,
      })
    } catch (err) {
      rejectFinale(err)
      throw err
    }
  }

  return {
    stream: generateStream(),
    final,
    abort() {
      controller.abort()
    },
  }
}

/**
 * 包装 StreamResult，使调用方可以在流式错误出现时返回一个新的 StreamResult 重试。
 *
 * 该 helper 不理解具体错误语义；中间件自行决定是否重试。为避免 UI 看到半段旧输出
 * 又接上重试输出，只要当前尝试已经向外 yield 过事件，后续错误就不再重试。
 */
export function retryStreamResult(
  initial: StreamResult,
  onError: StreamResultRetryHandler,
): StreamResult {
  let current = initial
  let emittedEvents = 0
  let resolveFinal!: (response: ChatResponse) => void
  let rejectFinal!: (error: unknown) => void

  const final = new Promise<ChatResponse>((resolve, reject) => {
    resolveFinal = resolve
    rejectFinal = reject
  })

  async function* generateStream(): AsyncIterable<AgentEvent> {
    let attempt = 0

    while (true) {
      const emittedBeforeAttempt = emittedEvents
      try {
        for await (const event of current.stream) {
          emittedEvents++
          yield event
        }

        const response = await current.final
        resolveFinal(response)
        return
      } catch (error) {
        const hasEmittedThisAttempt = emittedEvents > emittedBeforeAttempt
        if (hasEmittedThisAttempt) {
          rejectFinal(error)
          throw error
        }

        const next = await onError({ error, attempt, emittedEvents })
        if (!next) {
          rejectFinal(error)
          throw error
        }

        current = next
        attempt++
      }
    }
  }

  return {
    stream: generateStream(),
    final,
    abort() {
      current.abort()
    },
  }
}
