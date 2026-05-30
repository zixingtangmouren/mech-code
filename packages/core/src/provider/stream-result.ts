import type { AgentEvent } from '@mech/shared'
import type { ChatResponse, StreamResult, StreamNormalizer } from './types.js'
import { MessageAccumulator } from '../message/accumulator.js'

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
