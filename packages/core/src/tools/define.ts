import { z } from 'zod'
import type { Tool, ToolFlags, ToolRunContext, ToolOutput, ValidationResult } from './types.js'

// === 原始 JSON Schema 版本 ===

/**
 * defineTool 的初始化参数（原始 JSON Schema 版本）。
 * validateInput 为可选项，未提供时使用默认实现。
 */
export type ToolInit = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  flags: ToolFlags
  execute(input: Record<string, unknown>, context: ToolRunContext): Promise<ToolOutput> | ToolOutput
  validateInput?(input: Record<string, unknown>): ValidationResult | Promise<ValidationResult>
}

// === Zod Schema 版本 ===

/**
 * defineTool 的初始化参数（Zod schema 版本）。
 * - inputSchema 由 Zod schema 自动转换生成，无需手写 JSON Schema
 * - validateInput 由 Zod 的 safeParse 自动派生，无需手写
 * - execute 的 input 参数类型由 Zod schema 自动推导，完全类型安全
 */
export type ToolZodInit<TSchema extends z.ZodTypeAny> = {
  name: string
  description: string
  /** Zod schema，同时用于：生成 JSON Schema 发给 LLM + 运行时输入校验 */
  schema: TSchema
  flags: ToolFlags
  execute(input: z.infer<TSchema>, context: ToolRunContext): Promise<ToolOutput> | ToolOutput
  /** 额外的业务约束校验（在 Zod 校验通过之后执行） */
  validateInput?(input: z.infer<TSchema>): ValidationResult | Promise<ValidationResult>
}

// === 函数重载 ===

/**
 * defineTool —— 工具定义工厂函数。
 *
 * 支持两种调用方式：
 *
 * **方式一：原始 JSON Schema（兼容 MCP 工具或不依赖 Zod 的场景）**
 *   const tool = defineTool({
 *     name: 'read_file',
 *     inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
 *     flags: { readonly: true, parallelSafe: true },
 *     async execute(input, ctx) {
 *       const path = input.path as string  // 需要手动转型
 *     },
 *   })
 *
 * **方式二：Zod schema（推荐，完整类型安全 + 自动校验）**
 *   const tool = defineTool({
 *     name: 'read_file',
 *     schema: z.object({ path: z.string().min(1) }),
 *     flags: { readonly: true, parallelSafe: true },
 *     async execute(input, ctx) {
 *       const path = input.path  // string，类型安全，无需转型
 *     },
 *   })
 */
export function defineTool<TSchema extends z.ZodTypeAny>(init: ToolZodInit<TSchema>): Tool
export function defineTool(init: ToolInit): Tool
export function defineTool<TSchema extends z.ZodTypeAny>(
  init: ToolInit | ToolZodInit<TSchema>,
): Tool {
  // Zod schema 版本
  if ('schema' in init) {
    const { name, description, flags, schema } = init

    // Zod v4 内置 JSON Schema 转换，reused:'inline' 避免生成 $defs 引用
    const rawSchema = z.toJSONSchema(schema, { reused: 'inline' }) as Record<string, unknown>
    // 移除顶层 $schema 字段，LLM API（Anthropic/OpenAI）不接受此字段
    const { $schema: _$schema, ...inputSchema } = rawSchema

    return {
      name,
      description,
      inputSchema,
      flags,

      // 先用 Zod safeParse，再调用额外的业务校验（如有）
      async validateInput(raw) {
        const result = schema.safeParse(raw)
        if (!result.success) {
          return { valid: false, error: result.error.issues[0]?.message ?? '输入校验失败' }
        }
        if (init.validateInput) {
          return init.validateInput(result.data)
        }
        return { valid: true }
      },

      execute(raw, ctx) {
        return init.execute(raw as z.infer<TSchema>, ctx)
      },

      toDefinition() {
        return { name: this.name, description: this.description, inputSchema: this.inputSchema }
      },
    }
  }

  // 原始 JSON Schema 版本
  return {
    name: init.name,
    description: init.description,
    inputSchema: init.inputSchema,
    flags: init.flags,

    validateInput: (input) => init.validateInput?.(input) ?? { valid: true },

    execute: (raw, ctx) => init.execute(raw, ctx),

    toDefinition() {
      return { name: this.name, description: this.description, inputSchema: this.inputSchema }
    },
  }
}
