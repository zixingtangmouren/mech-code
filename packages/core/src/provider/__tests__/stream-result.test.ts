import { describe, expect, it, vi } from 'vitest'
import { retryStreamResult } from '../stream-result.js'
import type { ChatResponse, StreamResult } from '../types.js'

describe('retryStreamResult', () => {
  it('retries when stream fails before emitting events', async () => {
    const firstError = new Error('context too long')
    const retryResult = createResult({
      stream: (async function* () {
        yield { type: 'text_start' as const }
      })(),
      final: {
        content: [{ type: 'text', text: 'ok' }],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'end_turn',
      },
    })
    const wrapped = retryStreamResult(
      createResult({
        stream: (async function* () {
          throw firstError
        })(),
        final: emptyResponse(),
      }),
      vi.fn(() => retryResult),
    )

    const events = []
    for await (const event of wrapped.stream) {
      events.push(event)
    }

    await expect(wrapped.final).resolves.toMatchObject({ stopReason: 'end_turn' })
    expect(events).toEqual([{ type: 'text_start' }])
  })

  it('does not retry after emitting events', async () => {
    const firstError = new Error('late failure')
    const onError = vi.fn()
    const wrapped = retryStreamResult(
      createResult({
        stream: (async function* () {
          yield { type: 'text_start' as const }
          throw firstError
        })(),
        final: emptyResponse(),
      }),
      onError,
    )

    await expect(async () => {
      for await (const _event of wrapped.stream) {
        // consume stream
      }
    }).rejects.toThrow(firstError)
    await expect(wrapped.final).rejects.toThrow(firstError)
    expect(onError).not.toHaveBeenCalled()
  })
})

function createResult(options: {
  stream: AsyncIterable<StreamResult['stream'] extends AsyncIterable<infer T> ? T : never>
  final: ChatResponse
}): StreamResult {
  return {
    stream: options.stream,
    final: Promise.resolve(options.final),
    abort: vi.fn(),
  }
}

function emptyResponse(): ChatResponse {
  return {
    content: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    stopReason: 'error',
  }
}
