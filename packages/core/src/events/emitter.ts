import type { AgentEvent } from '@mech-code/shared'

/**
 * 创建一个用于 AgentEvent 的异步可迭代发射器。
 * 由 Agent Loop 内部使用，用于向消费者逐步产出事件。
 */
export function createEventEmitter(): {
  emit: (event: AgentEvent) => void
  iterable: AsyncIterable<AgentEvent>
  done: () => void
} {
  const queue: AgentEvent[] = []
  let resolve: (() => void) | null = null
  let finished = false

  const iterable: AsyncIterable<AgentEvent> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<AgentEvent>> {
          while (true) {
            if (queue.length > 0) {
              return { value: queue.shift()!, done: false }
            }
            if (finished) {
              return { value: undefined, done: true }
            }
            await new Promise<void>((r) => {
              resolve = r
            })
          }
        },
      }
    },
  }

  return {
    emit(event: AgentEvent) {
      queue.push(event)
      resolve?.()
      resolve = null
    },
    iterable,
    done() {
      finished = true
      resolve?.()
      resolve = null
    },
  }
}
