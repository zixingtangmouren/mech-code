import { describe, expect, it, vi } from 'vitest'
import { MiddlewarePipeline } from '../pipeline.js'
import { createMiddleware } from '../types.js'
import type { AgentMiddleware, RunContext } from '../types.js'
import type { Tool, ToolOutput } from '../../tools/types.js'
import type { AgentState } from '../../agent/state.js'
import type { LLMProvider } from '../../provider/types.js'

// === 辅助工厂 ===

function createMockTool(name: string): Tool {
  return {
    name,
    description: `Mock tool: ${name}`,
    inputSchema: { type: 'object' },
    flags: { readonly: true, parallelSafe: true },
    getPrompt: () => null,
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
    store: {},
  }
  return {
    state,
    callMessages: [],
    system: '',
    tools: [],
    lastResponse: undefined,
    props: Object.freeze({}),
    turnIndex: 0,
    provider: createMockProvider(),
    signal: new AbortController().signal,
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

    it('wrapToolCall 可读取 ctx.props', async () => {
      const receivedProps: unknown[] = []
      const mw: AgentMiddleware = {
        name: 'wrap-props-reader',
        async wrapToolCall(next, ctx) {
          receivedProps.push(ctx.props)
          return next(ctx)
        },
      }

      const pipeline = new MiddlewarePipeline([mw])
      const props = Object.freeze({ feature: 'enabled' })
      const baseFn = vi.fn(async (): Promise<ToolOutput> => ({ content: 'ok' }))
      const chain = pipeline.buildToolCallChain(baseFn)

      const ctx = {
        ...createMockRunContext({ props }),
        toolCallId: 'tc-1',
        toolName: 'test',
        toolInput: {},
      }

      await chain(ctx)

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
})

describe('createMiddleware', () => {
  it('返回合法的 AgentMiddleware 对象', () => {
    const mw = createMiddleware({
      name: 'test-mw',
      beforeModel(ctx) {
        ctx.system += ' appended'
      },
    })

    expect(mw.name).toBe('test-mw')
    expect(typeof mw.beforeModel).toBe('function')
    expect(mw.store).toBeUndefined()
  })

  it('store 被深克隆，修改原始对象不影响中间件实例', () => {
    const originalStore = { count: 0, nested: { value: 'hello' } }
    const mw = createMiddleware({
      name: 'cloned-store',
      store: originalStore,
    })

    // 修改原始对象
    originalStore.count = 99
    originalStore.nested.value = 'modified'

    // 中间件实例不受影响
    expect(mw.store!.count).toBe(0)
    expect((mw.store!.nested as { value: string }).value).toBe('hello')
  })

  it('多次调用返回独立的 store 实例', () => {
    function makeCounter() {
      return createMiddleware({
        name: 'counter',
        store: { count: 0 },
      })
    }

    const mw1 = makeCounter()
    const mw2 = makeCounter()

    mw1.store!.count = 5
    expect(mw2.store!.count).toBe(0)
  })

  it('无 store 时 store 为 undefined', () => {
    const mw = createMiddleware({ name: 'stateless' })
    expect(mw.store).toBeUndefined()
  })

  it('hooks 正常绑定和执行', async () => {
    const calls: string[] = []
    const mw = createMiddleware({
      name: 'hooks-test',
      store: { initialized: false },
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

  it('propsSchema 字段正确透传', () => {
    const mw = createMiddleware({
      name: 'with-schema',
      propsSchema: {
        userId: { description: '用户 ID', required: true },
      },
    })

    expect(mw.propsSchema?.userId?.required).toBe(true)
  })
})
