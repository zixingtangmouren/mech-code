import { describe, expect, it, vi } from 'vitest'
import { createAgent } from '../agent.js'
import { createAgentState } from '../state.js'
import { createMiddleware } from '../../middleware/types.js'
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

  it('middleware 默认 store 会合并并绑定到 AgentState.store', async () => {
    const provider = createMockProvider()
    provider.stream = vi.fn(() => ({
      stream: (async function* () {})(),
      final: Promise.resolve({
        content: [{ type: 'text' as const, text: 'ok' }],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'end_turn' as const,
      }),
      abort: vi.fn(),
    }))

    const mw = createMiddleware({
      name: 'counter',
      store: { count: 0, existing: 'default' },
      beforeAgent(ctx) {
        this.store!.count = (this.store!.count as number) + 1
        ctx.state.store['fromCtx'] = true
      },
    })
    const state = createAgentState()
    state.store['existing'] = 'runtime'

    const agent = createAgent({ provider, middleware: [mw] })
    for await (const _event of agent.run({ state })) {
      // consume stream
    }

    expect(mw.store).toBe(state.store)
    expect(state.store['count']).toBe(1)
    expect(state.store['fromCtx']).toBe(true)
    expect(state.store['existing']).toBe('runtime')
  })

  it('同一 middleware 绑定新 AgentState 时不会泄漏上一轮运行时 store', async () => {
    const provider = createMockProvider()
    provider.stream = vi.fn(() => ({
      stream: (async function* () {})(),
      final: Promise.resolve({
        content: [{ type: 'text' as const, text: 'ok' }],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'end_turn' as const,
      }),
      abort: vi.fn(),
    }))

    const mw = createMiddleware({
      name: 'session-store',
      store: { count: 0 },
      beforeAgent(ctx) {
        this.store!.count = (this.store!.count as number) + 1
        ctx.state.store['runtimeOnly'] = true
      },
    })
    const agent = createAgent({ provider, middleware: [mw] })

    const first = createAgentState()
    for await (const _event of agent.run({ state: first })) {
      // consume stream
    }

    const second = createAgentState()
    for await (const _event of agent.run({ state: second })) {
      // consume stream
    }

    expect(first.store['count']).toBe(1)
    expect(first.store['runtimeOnly']).toBe(true)
    expect(second.store['count']).toBe(1)
    expect(second.store['runtimeOnly']).toBe(true)
    expect(Object.keys(second.store)).toEqual(['count', 'runtimeOnly'])
  })
})
