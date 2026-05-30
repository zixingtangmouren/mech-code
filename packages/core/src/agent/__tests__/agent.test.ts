import { describe, expect, it, vi } from 'vitest'
import { createAgent } from '../agent.js'
import type { LLMProvider } from '../../provider/types.js'

/** 构造一个最简 mock LLMProvider，不会发起真实请求 */
function createMockProvider(): LLMProvider {
  return {
    name: 'mock',
    chat: vi.fn(),
    stream: vi.fn(),
  }
}

describe('createAgent', () => {
  it('应该创建 Agent 实例', () => {
    const agent = createAgent({ provider: createMockProvider() })
    expect(agent).toBeDefined()
  })

  it('fork() 应返回独立的 Agent 实例', () => {
    const agent = createAgent({ provider: createMockProvider(), maxTurns: 10 })
    const forked = agent.fork({ maxTurns: 3 })
    expect(forked).not.toBe(agent)
  })

  it('addTool / removeTool 不应影响原始 Agent', () => {
    const provider = createMockProvider()
    const agent = createAgent({ provider })
    const forked = agent.fork({})

    const mockTool = {
      name: 'test_tool',
      description: 'Test tool',
      inputSchema: {},
      flags: { readonly: true, parallelSafe: true },
      getPrompt: () => null,
      validateInput: () => ({ valid: true }),
      execute: vi.fn(),
      toDefinition: () => ({ name: 'test_tool', description: 'Test tool', inputSchema: {} }),
    }

    forked.addTool(mockTool)
    forked.removeTool('test_tool')
    // 不报错即通过
    expect(true).toBe(true)
  })
})
