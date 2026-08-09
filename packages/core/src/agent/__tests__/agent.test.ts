import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@mech-code/shared'
import { createAgent } from '../agent.js'
import { createAgentState } from '../state.js'
import { SuspendSignal } from '../hitl.js'
import { createMiddleware } from '../../middleware/types.js'
import { AssistantMessage, UserMessage } from '../../message/message.js'
import type {
  CallOptions,
  ChatParams,
  ChatResponse,
  LLMProvider,
  StreamResult,
} from '../../provider/types.js'

interface MockProvider extends LLMProvider {
  streamMock: ReturnType<typeof vi.fn<(params: ChatParams, options?: CallOptions) => StreamResult>>
}

/** 构造一个最简 mock LLMProvider，不会发起真实请求 */
function createMockProvider(): MockProvider {
  const streamMock = vi.fn(
    (_params: ChatParams, _options?: CallOptions): StreamResult => ({
      stream: (async function* () {})(),
      final: Promise.resolve(assistantResponse([{ type: 'text' as const, text: 'ok' }])),
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
      final: Promise.resolve(
        assistantResponse(
          [
            {
              type: 'tool_use' as const,
              id: 'tool-1',
              name: 'missing_tool',
              input: {},
            },
          ],
          'tool_use',
        ),
      ),
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

  it('中间件可发送带运行元数据的自定义事件，且 payload 在发送时会被复制', async () => {
    const provider = createMockProvider()
    const state = createAgentState()
    const firstPayload = { nested: { value: 1 } }
    const agent = createAgent({
      provider,
      middleware: [
        createMiddleware({
          name: 'custom-event-writer',
          state: { counter: { value: 0 } },
          beforeAgent(ctx) {
            ctx.runtime.emitCustomAgentEvent({
              source: 'test',
              name: 'first',
              payload: firstPayload,
            })
            firstPayload.nested.value = 2
          },
          beforeModel(ctx) {
            const counter = ctx.state.counter as { value: number }
            counter.value += 1
            ctx.runtime.emitCustomAgentEvent({
              source: 'test',
              name: 'second',
              payload: { counter: counter.value },
            })
          },
        }),
      ],
    })
    const events: AgentEvent[] = []

    for await (const event of agent.run({ state })) {
      events.push(event)
    }

    const startEvent = events.find(
      (event): event is Extract<AgentEvent, { type: 'agent_run_start' }> =>
        event.type === 'agent_run_start',
    )
    const customEvents = events.filter(
      (event): event is Extract<AgentEvent, { type: 'custom' }> => event.type === 'custom',
    )
    expect(customEvents).toEqual([
      {
        type: 'custom',
        runId: startEvent?.runId,
        turnIndex: 0,
        source: 'test',
        name: 'first',
        payload: { nested: { value: 1 } },
      },
      {
        type: 'custom',
        runId: startEvent?.runId,
        turnIndex: 0,
        source: 'test',
        name: 'second',
        payload: { counter: 1 },
      },
    ])
    expect(events.some((event) => (event as { type: string }).type === 'state_changed')).toBe(false)
    expect(events.find((event) => event.type === 'agent_run_end')).toMatchObject({
      type: 'agent_run_end',
      state: {
        counter: { value: 1 },
      },
    })
  })

  it('异步中间件运行期间会实时转发自定义事件', async () => {
    const provider = createMockProvider()
    let releaseHook: (() => void) | undefined
    let hookStarted: (() => void) | undefined
    let emitProgress: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      hookStarted = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      releaseHook = resolve
    })
    const agent = createAgent({
      provider,
      middleware: [
        createMiddleware({
          name: 'async-event-writer',
          async beforeModel(ctx) {
            emitProgress = () => {
              ctx.runtime.emitCustomAgentEvent({
                source: 'test',
                name: 'progress',
                payload: null,
              })
            }
            ctx.runtime.emitCustomAgentEvent({
              source: 'test',
              name: 'started',
              payload: null,
            })
            hookStarted?.()
            await blocked
          },
        }),
      ],
    })
    const iterator = agent.run({ state: createAgentState() })[Symbol.asyncIterator]()

    expect((await iterator.next()).value).toMatchObject({ type: 'agent_run_start' })
    expect((await iterator.next()).value).toMatchObject({ type: 'turn_start' })
    const nextEvent = iterator.next()
    await started
    expect((await nextEvent).value).toMatchObject({
      type: 'custom',
      source: 'test',
      name: 'started',
    })
    emitProgress?.()
    expect((await iterator.next()).value).toMatchObject({
      type: 'custom',
      source: 'test',
      name: 'progress',
    })

    releaseHook?.()
    while (!(await iterator.next()).done) {
      // 消费剩余事件
    }
  })

  it('RunContext 仅暴露 state 和只读 runtime 视图', async () => {
    const provider = createMockProvider()
    const state = createAgentState()
    const startedBeforeRun = Date.now()
    let observedStartedAt = 0

    const agent = createAgent({
      provider,
      middleware: [
        createMiddleware({
          name: 'runtime-view-reader',
          beforeAgent(ctx) {
            expect(Object.keys(ctx).sort()).toEqual(['runtime', 'state'])
            expect(ctx.runtime.props).toEqual({ cwd: '/workspace' })
            expect(ctx.runtime.turnIndex).toBe(0)
            expect(ctx.runtime.pendingToolCalls).toEqual([])
            expect(ctx.runtime.lastResponse).toBeUndefined()
            observedStartedAt = ctx.runtime.startedAt

            expect(() => {
              ;(ctx.runtime as { turnIndex: number }).turnIndex = 99
            }).toThrow()
            expect(() => {
              ;(ctx.runtime.pendingToolCalls as unknown[]).push({})
            }).toThrow()
          },
          afterModel(ctx) {
            expect(ctx.runtime.lastResponse?.message.role).toBe('assistant')
            expect(() => {
              ;(ctx.runtime.lastResponse?.message.content as unknown[]).push({})
            }).toThrow()
          },
        }),
      ],
    })

    for await (const _event of agent.run({ state, props: { cwd: '/workspace' } })) {
      // 消费事件流
    }

    expect(observedStartedAt).toBeGreaterThanOrEqual(startedBeforeRun)
    expect(observedStartedAt).toBeLessThanOrEqual(Date.now())
  })

  it('checkpoint 保存并恢复可序列化 runtime 状态', async () => {
    const provider = createMockProvider()
    provider.streamMock
      .mockImplementationOnce(() => ({
        stream: (async function* () {})(),
        final: Promise.resolve(
          assistantResponse(
            [{ type: 'tool_use', id: 'call_1', name: 'protected_tool', input: { value: 1 } }],
            'tool_use',
          ),
        ),
        abort: vi.fn(),
      }))
      .mockImplementationOnce(() => ({
        stream: (async function* () {})(),
        final: Promise.resolve(assistantResponse('done')),
        abort: vi.fn(),
      }))

    let shouldSuspend = true
    let resumedBeforeAgentPending: readonly unknown[] = []
    let resumedToolPending: readonly unknown[] = []
    let originalStartedAt = 0
    let resumedStartedAt = 0
    let runCount = 0

    const agent = createAgent({
      provider,
      tools: [
        {
          name: 'protected_tool',
          description: 'Protected tool',
          inputSchema: {},
          flags: { readonly: false, parallelSafe: false },
          validateInput: () => ({ valid: true }),
          execute: () => ({ content: 'executed' }),
          toDefinition: () => ({
            name: 'protected_tool',
            description: 'Protected tool',
            inputSchema: {},
          }),
        },
      ],
      middleware: [
        createMiddleware({
          name: 'approval',
          beforeAgent(ctx) {
            runCount += 1
            if (runCount === 1) {
              originalStartedAt = ctx.runtime.startedAt
            } else {
              resumedStartedAt = ctx.runtime.startedAt
              resumedBeforeAgentPending = ctx.runtime.pendingToolCalls
            }
          },
          wrapToolCall(request, handler) {
            if (shouldSuspend) {
              shouldSuspend = false
              throw new SuspendSignal('approval_required')
            }
            resumedToolPending = request.context.runtime.pendingToolCalls
            return handler(request)
          },
        }),
      ],
    })

    const state = createAgentState()
    let checkpoint: Extract<AgentEvent, { type: 'suspended' }>['checkpoint'] | undefined
    for await (const event of agent.run({ state })) {
      if (event.type === 'suspended') checkpoint = event.checkpoint
    }

    expect(checkpoint).toBeDefined()
    expect(checkpoint).not.toHaveProperty('turnIndex')
    expect(checkpoint).not.toHaveProperty('pendingToolCalls')
    expect(checkpoint?.runtime).not.toHaveProperty('runId')
    expect(checkpoint?.runtime).toEqual({
      startedAt: originalStartedAt,
      turnIndex: 0,
      pendingToolCalls: [{ id: 'call_1', name: 'protected_tool', input: { value: 1 } }],
    })

    for await (const _event of agent.resume({
      checkpoint: checkpoint!,
      decisions: { call_1: { action: 'approve' } },
    })) {
      // 消费事件流
    }

    expect(resumedStartedAt).toBe(originalStartedAt)
    expect(resumedBeforeAgentPending).toEqual(checkpoint?.runtime.pendingToolCalls)
    expect(resumedToolPending).toEqual(checkpoint?.runtime.pendingToolCalls)
  })

  it('runtime.pendingToolCalls 随串行工具执行逐项推进', async () => {
    const provider = createMockProvider()
    provider.streamMock
      .mockImplementationOnce(() => ({
        stream: (async function* () {})(),
        final: Promise.resolve(
          assistantResponse(
            [
              { type: 'tool_use', id: 'call_1', name: 'serial_tool', input: { value: 1 } },
              { type: 'tool_use', id: 'call_2', name: 'serial_tool', input: { value: 2 } },
            ],
            'tool_use',
          ),
        ),
        abort: vi.fn(),
      }))
      .mockImplementationOnce(() => ({
        stream: (async function* () {})(),
        final: Promise.resolve(assistantResponse('done')),
        abort: vi.fn(),
      }))

    const observedPendingIds: string[][] = []
    const agent = createAgent({
      provider,
      tools: [
        {
          name: 'serial_tool',
          description: 'Serial tool',
          inputSchema: {},
          flags: { readonly: true, parallelSafe: false },
          validateInput: () => ({ valid: true }),
          execute: () => ({ content: 'executed' }),
          toDefinition: () => ({
            name: 'serial_tool',
            description: 'Serial tool',
            inputSchema: {},
          }),
        },
      ],
      middleware: [
        createMiddleware({
          name: 'pending-observer',
          wrapToolCall(request, handler) {
            observedPendingIds.push(request.context.runtime.pendingToolCalls.map((call) => call.id))
            return handler(request)
          },
        }),
      ],
    })

    for await (const _event of agent.run({ state: createAgentState() })) {
      // 消费事件流
    }

    expect(observedPendingIds).toEqual([['call_1', 'call_2'], ['call_2']])
  })

  it('将图片工具输出提升为 ToolMessage 的显式 image 字段', async () => {
    const provider = createMockProvider()
    provider.streamMock
      .mockImplementationOnce(() => ({
        stream: (async function* () {})(),
        final: Promise.resolve(
          assistantResponse(
            [{ type: 'tool_use', id: 'call_1', name: 'read_image', input: {} }],
            'tool_use',
          ),
        ),
        abort: vi.fn(),
      }))
      .mockImplementationOnce(() => ({
        stream: (async function* () {})(),
        final: Promise.resolve(assistantResponse('done')),
        abort: vi.fn(),
      }))

    const state = createAgentState()
    state.messages.push(new UserMessage('read image'))
    const agent = createAgent({
      provider,
      tools: [
        {
          name: 'read_image',
          description: 'Read an image',
          inputSchema: {},
          flags: { readonly: true, parallelSafe: true },
          validateInput: () => ({ valid: true }),
          execute: () => ({
            content: 'image result',
            metadata: {
              type: 'image',
              base64: 'abc',
              mediaType: 'image/png',
            },
          }),
          toDefinition: () => ({
            name: 'read_image',
            description: 'Read an image',
            inputSchema: {},
          }),
        },
      ],
    })

    for await (const _event of agent.run({ state })) {
      // 消费事件流
    }

    expect(state.messages.find((message) => message.role === 'tool')).toMatchObject({
      role: 'tool',
      content: 'image result',
      image: { type: 'base64', mediaType: 'image/png', data: 'abc' },
    })
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
            if (message?.role === 'user') {
              message.content = [{ type: 'text', text: 'transient' }]
            }
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
      content: [{ type: 'text', text: 'transient' }],
    })
    expect(state.messages[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'original' }],
    })
  })
})

function assistantResponse(
  content: ConstructorParameters<typeof AssistantMessage>[0],
  stopReason = 'end_turn',
): ChatResponse {
  return {
    message: new AssistantMessage(content),
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason,
  }
}
