import { describe, expect, it } from 'vitest'
import { createAgent } from '../agent.js'

describe('createAgent', () => {
  it('should create an Agent instance', () => {
    const agent = createAgent({
      provider: { model: 'test', apiKey: 'test' },
    })
    expect(agent).toBeDefined()
  })
})
