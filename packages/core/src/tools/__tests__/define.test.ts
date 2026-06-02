import { describe, expect, it, beforeEach } from 'vitest'
import { z } from 'zod'
import { defineTool } from '../define.js'
import { registerTool, getTool, getAllTools, getToolDefinitions, clearTools } from '../registry.js'
import type { ToolRunContext } from '../types.js'

// 测试用的最小执行上下文
const mockCtx: ToolRunContext = {
  cwd: '/tmp',
  signal: new AbortController().signal,
  store: {},
}

describe('defineTool', () => {
  it('必填项正确赋值', () => {
    const tool = defineTool({
      name: 'echo',
      description: '回显输入',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      flags: { readonly: true, parallelSafe: true },
      async execute(input) {
        return { content: input['text'] as string }
      },
    })

    expect(tool.name).toBe('echo')
    expect(tool.flags.readonly).toBe(true)
    expect(tool.flags.parallelSafe).toBe(true)
  })

  it('getPrompt 默认返回 null', () => {
    const tool = defineTool({
      name: 'echo',
      description: '',
      inputSchema: {},
      flags: { readonly: true, parallelSafe: true },
      async execute() {
        return { content: '' }
      },
    })
    expect(tool.getPrompt({ cwd: '/', availableTools: [], turnIndex: 0, store: {} })).toBeNull()
  })

  it('validateInput 默认返回 valid: true', async () => {
    const tool = defineTool({
      name: 'echo',
      description: '',
      inputSchema: {},
      flags: { readonly: true, parallelSafe: true },
      async execute() {
        return { content: '' }
      },
    })
    const result = await tool.validateInput({})
    expect(result.valid).toBe(true)
  })

  it('自定义 validateInput 生效', async () => {
    const tool = defineTool({
      name: 'read_file',
      description: '读取文件',
      inputSchema: {},
      flags: { readonly: true, parallelSafe: true },
      validateInput(input) {
        const path = input['path'] as string
        if (path?.includes('..')) return { valid: false, error: '路径不允许包含 ..' }
        return { valid: true }
      },
      async execute() {
        return { content: '' }
      },
    })

    expect(await tool.validateInput({ path: '../etc/passwd' })).toEqual({
      valid: false,
      error: '路径不允许包含 ..',
    })
    expect(await tool.validateInput({ path: 'src/index.ts' })).toEqual({ valid: true })
  })

  it('自定义 getPrompt 生效', () => {
    const tool = defineTool({
      name: 'bash',
      description: '执行命令',
      inputSchema: {},
      flags: { readonly: false, parallelSafe: true },
      getPrompt(ctx) {
        return `执行命令（当前目录: ${ctx.cwd}）`
      },
      async execute() {
        return { content: '' }
      },
    })

    const result = tool.getPrompt({ cwd: '/app', availableTools: [], turnIndex: 0, store: {} })
    expect(result).toBe('执行命令（当前目录: /app）')
  })

  it('toDefinition 只返回三个字段', () => {
    const tool = defineTool({
      name: 'search',
      description: '搜索文件',
      inputSchema: { type: 'object' },
      flags: { readonly: true, parallelSafe: true },
      async execute() {
        return { content: '' }
      },
    })

    expect(tool.toDefinition()).toEqual({
      name: 'search',
      description: '搜索文件',
      inputSchema: { type: 'object' },
    })
  })

  it('execute 正确执行并返回 ToolOutput', async () => {
    const tool = defineTool({
      name: 'greet',
      description: '',
      inputSchema: {},
      flags: { readonly: true, parallelSafe: true },
      async execute(input) {
        return { content: `Hello, ${input['name'] as string}!`, isError: false }
      },
    })

    const output = await tool.execute({ name: 'world' }, mockCtx)
    expect(output).toEqual({ content: 'Hello, world!', isError: false })
  })
})

describe('registry', () => {
  beforeEach(() => {
    clearTools()
  })

  it('注册和获取工具', () => {
    const tool = defineTool({
      name: 'ping',
      description: '',
      inputSchema: {},
      flags: { readonly: true, parallelSafe: true },
      async execute() {
        return { content: 'pong' }
      },
    })

    registerTool(tool)
    expect(getTool('ping')).toBe(tool)
  })

  it('getAllTools 返回所有已注册工具', () => {
    const t1 = defineTool({
      name: 't1',
      description: '',
      inputSchema: {},
      flags: { readonly: true, parallelSafe: true },
      async execute() {
        return { content: '' }
      },
    })
    const t2 = defineTool({
      name: 't2',
      description: '',
      inputSchema: {},
      flags: { readonly: false, parallelSafe: false },
      async execute() {
        return { content: '' }
      },
    })

    registerTool(t1)
    registerTool(t2)
    expect(getAllTools()).toHaveLength(2)
  })

  it('getToolDefinitions 返回精简定义列表', () => {
    registerTool(
      defineTool({
        name: 'list_files',
        description: '列出文件',
        inputSchema: { type: 'object' },
        flags: { readonly: true, parallelSafe: true },
        async execute() {
          return { content: '' }
        },
      }),
    )

    const defs = getToolDefinitions()
    expect(defs).toHaveLength(1)
    expect(defs[0]).toEqual({
      name: 'list_files',
      description: '列出文件',
      inputSchema: { type: 'object' },
    })
    // 精简定义不含 flags / execute 等字段
    expect(defs[0]).not.toHaveProperty('flags')
    expect(defs[0]).not.toHaveProperty('execute')
  })

  it('clearTools 清空注册表', () => {
    registerTool(
      defineTool({
        name: 'tmp',
        description: '',
        inputSchema: {},
        flags: { readonly: true, parallelSafe: true },
        async execute() {
          return { content: '' }
        },
      }),
    )
    clearTools()
    expect(getAllTools()).toHaveLength(0)
  })
})

// ============================================================
// Zod schema 版本测试
// ============================================================

describe('defineTool (Zod schema)', () => {
  it('execute input 类型由 schema 自动推导', async () => {
    const schema = z.object({ path: z.string(), encoding: z.enum(['utf8', 'binary']).optional() })

    const tool = defineTool({
      name: 'read_file',
      description: '读取文件',
      schema,
      flags: { readonly: true, parallelSafe: true },
      async execute(input) {
        // input 类型为 { path: string; encoding?: 'utf8' | 'binary' }，无需转型
        return { content: `file:${input.path}` }
      },
    })

    const output = await tool.execute({ path: 'src/index.ts' }, mockCtx)
    expect(output.content).toBe('file:src/index.ts')
  })

  it('Zod 校验失败时 validateInput 返回 valid: false', async () => {
    const tool = defineTool({
      name: 'greet',
      description: '',
      schema: z.object({ name: z.string().min(1, '姓名不能为空') }),
      flags: { readonly: true, parallelSafe: true },
      async execute(input) {
        return { content: input.name }
      },
    })

    const fail = await tool.validateInput({ name: '' })
    expect(fail.valid).toBe(false)
    expect(fail.error).toBe('姓名不能为空')

    const ok = await tool.validateInput({ name: 'Alice' })
    expect(ok.valid).toBe(true)
  })

  it('Zod 校验通过后执行额外 validateInput', async () => {
    const tool = defineTool({
      name: 'read_file',
      description: '',
      schema: z.object({ path: z.string() }),
      flags: { readonly: true, parallelSafe: true },
      validateInput(input) {
        if (input.path.includes('..')) return { valid: false, error: '路径不允许包含 ..' }
        return { valid: true }
      },
      async execute(input) {
        return { content: input.path }
      },
    })

    expect(await tool.validateInput({ path: '../etc/passwd' })).toEqual({
      valid: false,
      error: '路径不允许包含 ..',
    })
    expect(await tool.validateInput({ path: 'src/index.ts' })).toEqual({ valid: true })
  })

  it('inputSchema 自动转换为 JSON Schema', () => {
    const tool = defineTool({
      name: 'write_file',
      description: '写文件',
      schema: z.object({
        path: z.string(),
        content: z.string(),
        append: z.boolean().optional(),
      }),
      flags: { readonly: false, parallelSafe: false },
      async execute(input) {
        return { content: `wrote ${input.path}` }
      },
    })

    const schema = tool.inputSchema
    // JSON Schema 应有 type: object 和 properties
    expect(schema['type']).toBe('object')
    expect(schema['properties']).toHaveProperty('path')
    expect(schema['properties']).toHaveProperty('content')
    // 不应含 $schema 顶层字段
    expect(schema).not.toHaveProperty('$schema')
  })

  it('toDefinition 只返回 name/description/inputSchema', () => {
    const tool = defineTool({
      name: 'search',
      description: '搜索',
      schema: z.object({ query: z.string() }),
      flags: { readonly: true, parallelSafe: true },
      async execute(input) {
        return { content: input.query }
      },
    })

    const def = tool.toDefinition()
    expect(Object.keys(def)).toEqual(['name', 'description', 'inputSchema'])
  })

  it('Zod 类型错误时 validateInput 返回有意义的错误信息', async () => {
    const tool = defineTool({
      name: 'typed',
      description: '',
      schema: z.object({ count: z.number().int().positive() }),
      flags: { readonly: true, parallelSafe: true },
      async execute(input) {
        return { content: String(input.count) }
      },
    })

    const result = await tool.validateInput({ count: -1 })
    expect(result.valid).toBe(false)
    expect(result.error).toBeTruthy()
  })
})
