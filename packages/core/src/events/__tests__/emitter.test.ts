import { describe, expect, it } from 'vitest'
import { createEventEmitter } from '../emitter.js'

describe('createEventEmitter', () => {
  it('should emit and consume events via async iterable', async () => {
    const { emit, iterable, done } = createEventEmitter()

    emit({ type: 'text_delta', delta: 'hello' })
    emit({ type: 'text_delta', delta: ' world' })
    done()

    const results: string[] = []
    for await (const event of iterable) {
      if (event.type === 'text_delta') {
        results.push(event.delta)
      }
    }

    expect(results).toEqual(['hello', ' world'])
  })
})
