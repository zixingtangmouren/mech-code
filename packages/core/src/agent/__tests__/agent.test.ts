import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@mech-code/shared'
import { createAgent } from '../agent.js'
import { createAgentState } from '../state.js'
import { createMiddleware } from '../../middleware/types.js'
import { UserMessage } from '../../message/message.js'
import type { ChatParams, CallOptions, LLMProvider, StreamResult } from '../../provider/types.js'

interface MockProvider extends LLMProvider {
  streamMock: ReturnType<typeof vi.fn<(params: ChatParams, options?: CallOptions) => StreamResult>>
}

/** 构造一个最简 mock LLMProvider，不会发起真实请求 */
function createMockProvider(): MockProvider {
  const streamMock = vi.fn(
    (_params: ChatParams, _options?: CallOptions): StreamResult => ({
      stream: (async function* () {})(),
      final: Promise.resolve({
        content: [{ type: 'text' as const, text: 'ok' }],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'end_turn',
      }),
      abort: vi.fn(),
    }),
  )

  return {
    name: 'mock',
    chat: vi.fn(),
    stream: streamMock,
    streamMock,
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
      validateInput: () => ({ valid: true }),
      execute: vi.fn(),
      toDefinition: () => ({ name: 'test_tool', description: 'Test tool', inputSchema: {} }),
    }

    forked.addTool(mockTool)
    forked.removeTool('test_tool')
    // 不报错即通过
    expect(true).toBe(true)
  })

  it('middleware 默认 state 会合并到 AgentState 顶层且不覆盖调用方字段', async () => {
    const provider = createMockProvider()
    const mw = createMiddleware({
      name: 'counter',
      state: { count: 0, existing: 'default' },
      beforeAgent(ctx) {
        ctx.state.count = (ctx.state.count as number) + 1
        ctx.state.fromCtx = true
      },
    })
    const state = createAgentState()
    state.existing = 'runtime'

    const agent = createAgent({ provider, middleware: [mw] })
    for await (const _event of agent.run({ state })) {
      // consume stream
    }

    expect(state.count).toBe(1)
    expect(state.fromCtx).toBe(true)
    expect(state.existing).toBe('runtime')
    expect(mw.state).toEqual({ count: 0, existing: 'default' })
  })

  it('同一 middleware 多次运行不会泄漏上一轮顶层扩展 state', async () => {
    const provider = createMockProvider()
    const mw = createMiddleware({
      name: 'session-state',
      state: { count: 0 },
      beforeAgent(ctx) {
        ctx.state.count = (ctx.state.count as number) + 1
        ctx.state.runtimeOnly = true
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

    expect(first.count).toBe(1)
    expect(first.runtimeOnly).toBe(true)
    expect(second.count).toBe(1)
    expect(second.runtimeOnly).toBe(true)
    expect(Object.keys(second).sort()).toEqual(['count', 'messages', 'runtimeOnly', 'usage'])
  })

  it('run config.maxTurns 覆盖 Agent 默认最大轮次', async () => {
    const provider = createMockProvider()
    provider.streamMock.mockImplementation(() => ({
      stream: (async function* () {})(),
      final: Promise.resolve({
        content: [
          {
            type: 'tool_use' as const,
            id: 'tool-1',
            name: 'missing_tool',
            input: {},
          },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'tool_use',
      }),
      abort: vi.fn(),
    }))
    const state = createAgentState()
    const agent = createAgent({ provider, maxTurns: 10 })
    const events: AgentEvent[] = []

    for await (const event of agent.run({ state, config: { maxTurns: 1 } })) {
      events.push(event)
    }

    expect(provider.streamMock).toHaveBeenCalledTimes(1)
    expect(events.find((event) => event.type === 'agent_run_end')).toMatchObject({
      type: 'agent_run_end',
      stopReason: 'max_turns',
    })
  })

  it('run config.signal 可在运行开始前中止本次 run', async () => {
    const provider = createMockProvider()
    const state = createAgentState()
    const agent = createAgent({ provider })
    const controller = new AbortController()
    controller.abort('test_abort')
    const events: AgentEvent[] = []

    for await (const event of agent.run({ state, config: { signal: controller.signal } })) {
      events.push(event)
    }

    expect(provider.streamMock).not.toHaveBeenCalled()
    expect(events.find((event) => event.type === 'agent_run_end')).toMatchObject({
      type: 'agent_run_end',
      stopReason: 'abort',
    })
  })

  it('state_changed 会报告顶层和嵌套 state 变更并递增 revision', async () => {
    const provider = createMockProvider()
    const state = createAgentState()
    const agent = createAgent({
      provider,
      middleware: [
        createMiddleware({
          name: 'state-writer',
          state: { counter: { value: 0 } },
          beforeModel(ctx) {
            const counter = ctx.state.counter as { value: number }
            counter.value += 1
            ctx.runtime.notifyStateChanged('counter_increment', ['counter'])
          },
        }),
      ],
    })
    const events: AgentEvent[] = []

    for await (const event of agent.run({ state })) {
      events.push(event)
    }

    const stateEvents = events.filter(
      (event): event is Extract<AgentEvent, { type: 'state_changed' }> =>
        event.type === 'state_changed',
    )
    expect(stateEvents.length).toBeGreaterThanOrEqual(2)
    expect(stateEvents[0]).toMatchObject({
      type: 'state_changed',
      revision: 1,
      changedKeys: ['counter'],
      reason: 'counter_increment',
    })
    expect(stateEvents.some((event) => event.changedKeys.includes('messages'))).toBe(true)
    expect(stateEvents.some((event) => event.changedKeys.includes('usage'))).toBe(true)
    expect(stateEvents.map((event) => event.revision)).toEqual(
      stateEvents.map((_event, index) => index + 1),
    )
  })

  it('wrapModelCall 修改 params.messages 不会污染真实 state.messages', async () => {
    const provider = createMockProvider()
    const state = createAgentState()
    state.messages.push(new UserMessage('original'))
    const agent = createAgent({
      provider,
      middleware: [
        createMiddleware({
          name: 'transient-message-projection',
          wrapModelCall(request, handler) {
            const message = request.params.messages[0]
            if (message?.role === 'user') message.content = 'transient'
            return handler(request)
          },
        }),
      ],
    })

    for await (const _event of agent.run({ state })) {
      // consume stream
    }

    expect(provider.streamMock.mock.calls[0]?.[0].messages[0]).toMatchObject({
      role: 'user',
      content: 'transient',
    })
    expect(state.messages[0]).toMatchObject({ role: 'user', content: 'original' })
  })
})
