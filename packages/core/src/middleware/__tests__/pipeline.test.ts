import { describe, expect, it, vi } from 'vitest'
import { MiddlewarePipeline } from '../pipeline.js'
import { createMiddleware } from '../types.js'
import type { AgentMiddleware, ModelCallRequest, RunContext, ToolCallRequest } from '../types.js'
import type { Tool, ToolOutput } from '../../tools/types.js'
import type { AgentState } from '../../agent/state.js'
import type { LLMProvider, StreamResult } from '../../provider/types.js'

// === 辅助工厂 ===

function createMockTool(name: string): Tool {
  return {
    name,
    description: `Mock tool: ${name}`,
    inputSchema: { type: 'object' },
    flags: { readonly: true, parallelSafe: true },
    validateInput: () => ({ valid: true }),
    execute: () => ({ content: `executed ${name}` }),
    toDefinition: () => ({ name, description: `Mock tool: ${name}`, inputSchema: {} }),
  }
}

function createMockProvider(): LLMProvider {
  return { name: 'mock', chat: vi.fn(), stream: vi.fn() }
}

function createMockRunContext(overrides?: Partial<RunContext>): RunContext {
  const state: AgentState = {
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
  }
  return {
    state,
    props: Object.freeze({}),
    runtime: {
      runId: 'run-test',
      provider: createMockProvider(),
      system: '',
      tools: [],
      middleware: [],
      signal: new AbortController().signal,
      emit: vi.fn(),
      notifyStateChanged: vi.fn(),
    },
    loopState: {
      turnIndex: 0,
      stopReason: 'end_turn',
      lastResponse: undefined,
      pendingToolCalls: [],
      stateRevision: 0,
    },
    ...overrides,
  }
}

// === 测试 ===

describe('MiddlewarePipeline', () => {
  describe('collectMiddlewareTools', () => {
    it('无工具声明时返回空数组', () => {
      const pipeline = new MiddlewarePipeline([{ name: 'mw-a' }, { name: 'mw-b' }])
      expect(pipeline.collectMiddlewareTools()).toEqual([])
    })

    it('正确收集中间件声明的工具及来源', () => {
      const toolA = createMockTool('tool_a')
      const toolB = createMockTool('tool_b')
      const toolC = createMockTool('tool_c')

      const pipeline = new MiddlewarePipeline([
        { name: 'mw-1', tools: [toolA, toolB] },
        { name: 'mw-2', tools: [toolC] },
        { name: 'mw-3' },
      ])

      const result = pipeline.collectMiddlewareTools()
      expect(result).toHaveLength(3)
      expect(result[0]).toEqual({ tool: toolA, source: 'mw-1' })
      expect(result[1]).toEqual({ tool: toolB, source: 'mw-1' })
      expect(result[2]).toEqual({ tool: toolC, source: 'mw-2' })
    })

    it('tools 为空数组时不收集', () => {
      const pipeline = new MiddlewarePipeline([{ name: 'mw-empty', tools: [] }])
      expect(pipeline.collectMiddlewareTools()).toEqual([])
    })
  })

  describe('hooks 与 props 访问', () => {
    it('beforeModel hook 可读取 ctx.props', async () => {
      const receivedProps: unknown[] = []
      const mw: AgentMiddleware = {
        name: 'props-reader',
        beforeModel(ctx) {
          receivedProps.push(ctx.props)
        },
      }

      const pipeline = new MiddlewarePipeline([mw])
      const props = Object.freeze({ userId: 'u-123', limit: 50 })
      const ctx = createMockRunContext({ props })

      await pipeline.runBeforeModel(ctx)

      expect(receivedProps[0]).toBe(props)
      expect((receivedProps[0] as Record<string, unknown>).userId).toBe('u-123')
    })

    it('props 被 freeze 后不可修改', () => {
      const props = Object.freeze({ key: 'value' })
      expect(() => {
        ;(props as Record<string, unknown>).key = 'changed'
      }).toThrow()
    })

    it('wrapToolCall 可读取 request.context.props', async () => {
      const receivedProps: unknown[] = []
      const mw: AgentMiddleware = {
        name: 'wrap-props-reader',
        async wrapToolCall(request, handler) {
          receivedProps.push(request.context.props)
          return handler(request)
        },
      }

      const pipeline = new MiddlewarePipeline([mw])
      const props = Object.freeze({ feature: 'enabled' })
      const baseFn = vi.fn(async (): Promise<ToolOutput> => ({ content: 'ok' }))
      const chain = pipeline.buildToolCallChain(baseFn)

      const request = {
        context: createMockRunContext({ props }),
        toolCallId: 'tc-1',
        toolName: 'test',
        toolInput: {},
      }

      await chain(request)

      expect(receivedProps[0]).toBe(props)
      expect(baseFn).toHaveBeenCalled()
    })
  })

  describe('hook 执行顺序', () => {
    it('beforeModel hooks 按注册顺序执行', async () => {
      const order: string[] = []
      const mwA: AgentMiddleware = {
        name: 'a',
        beforeModel() {
          order.push('a')
        },
      }
      const mwB: AgentMiddleware = {
        name: 'b',
        beforeModel() {
          order.push('b')
        },
      }

      const pipeline = new MiddlewarePipeline([mwA, mwB])
      await pipeline.runBeforeModel(createMockRunContext())

      expect(order).toEqual(['a', 'b'])
    })

    it('afterAgent 异常不向上传播', async () => {
      const mw: AgentMiddleware = {
        name: 'throw-after',
        afterAgent() {
          throw new Error('boom')
        },
      }

      const pipeline = new MiddlewarePipeline([mw])
      await expect(pipeline.runAfterAgent(createMockRunContext())).resolves.toBeUndefined()
    })
  })

  describe('wrap 调用链', () => {
    it('wrapToolCall 可改写真正传给 handler 的工具入参', async () => {
      const mw: AgentMiddleware = {
        name: 'rewrite-tool-input',
        wrapToolCall(request, handler) {
          return handler({
            ...request,
            toolInput: {
              ...request.toolInput,
              value: 'rewritten',
            },
          })
        },
      }
      const baseFn = vi.fn(
        async (_request: ToolCallRequest): Promise<ToolOutput> => ({
          content: 'ok',
        }),
      )
      const chain = new MiddlewarePipeline([mw]).buildToolCallChain(baseFn)

      await chain({
        context: createMockRunContext(),
        toolCallId: 'tc-1',
        toolName: 'test',
        toolInput: { value: 'original' },
      })

      expect(baseFn.mock.calls[0]?.[0].toolInput).toEqual({ value: 'rewritten' })
    })

    it('wrapModelCall 可改写真正传给 handler 的 provider 参数', async () => {
      const streamResult: StreamResult = {
        stream: (async function* () {})(),
        final: Promise.resolve({
          content: [{ type: 'text', text: 'ok' }],
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: 'end_turn',
        }),
        abort: vi.fn(),
      }
      const mw: AgentMiddleware = {
        name: 'append-system',
        wrapModelCall(request, handler) {
          return handler({
            ...request,
            params: {
              ...request.params,
              system: `${request.params.system ?? ''}\nextra`.trim(),
            },
          })
        },
      }
      const baseFn = vi.fn(
        async (_request: ModelCallRequest): Promise<StreamResult> => streamResult,
      )
      const context = createMockRunContext()
      const chain = new MiddlewarePipeline([mw]).buildModelCallChain(baseFn)

      await chain({
        context,
        provider: context.runtime.provider,
        params: { messages: [], system: 'base' },
        options: { signal: context.runtime.signal },
      })

      expect(baseFn.mock.calls[0]?.[0].params.system).toBe('base\nextra')
    })
  })
})

describe('createMiddleware', () => {
  it('返回合法的 AgentMiddleware 对象', () => {
    const mw = createMiddleware({
      name: 'test-mw',
      beforeModel(ctx) {
        ctx.runtime.system += ' appended'
      },
    })

    expect(mw.name).toBe('test-mw')
    expect(typeof mw.beforeModel).toBe('function')
    expect(mw.state).toBeUndefined()
  })

  it('state 被深克隆，修改原始对象不影响中间件实例', () => {
    const originalState = { count: 0, nested: { value: 'hello' } }
    const mw = createMiddleware({
      name: 'cloned-state',
      state: originalState,
    })

    originalState.count = 99
    originalState.nested.value = 'modified'

    expect(mw.state!.count).toBe(0)
    expect((mw.state!.nested as { value: string }).value).toBe('hello')
  })

  it('多次调用返回独立的 state 实例', () => {
    function makeCounter() {
      return createMiddleware({
        name: 'counter',
        state: { count: 0 },
      })
    }

    const mw1 = makeCounter()
    const mw2 = makeCounter()

    mw1.state!.count = 5
    expect(mw2.state!.count).toBe(0)
  })

  it('无 state 时 state 为 undefined', () => {
    const mw = createMiddleware({ name: 'stateless' })
    expect(mw.state).toBeUndefined()
  })

  it('hooks 正常绑定和执行', async () => {
    const calls: string[] = []
    const mw = createMiddleware({
      name: 'hooks-test',
      state: { initialized: false },
      beforeAgent(_ctx) {
        calls.push('beforeAgent')
      },
      beforeModel(_ctx) {
        calls.push('beforeModel')
      },
    })

    const pipeline = new MiddlewarePipeline([mw])
    const ctx = createMockRunContext()

    await pipeline.runBeforeAgent(ctx)
    await pipeline.runBeforeModel(ctx)

    expect(calls).toEqual(['beforeAgent', 'beforeModel'])
  })

  it('tools 字段正确透传', () => {
    const tool = createMockTool('my-tool')
    const mw = createMiddleware({
      name: 'with-tools',
      tools: [tool],
    })

    expect(mw.tools).toHaveLength(1)
    expect(mw.tools?.[0]?.name).toBe('my-tool')
  })
})
