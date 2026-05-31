import type {
  AgentMiddleware,
  RunContext,
  ModelCallFn,
  ToolCallFn,
  ToolCallContext,
} from './types.js'
import type { StreamResult } from '../provider/types.js'
import type { ToolOutput } from '../tools/types.js'

/**
 * 中间件管道执行器。
 *
 * - **Hook 式**：按注册顺序依次执行，某个 Hook 抛异常则终止整条链
 * - **Wrap 式**：从后往前包裹，最先注册的中间件在最外层（洋葱模型）
 *
 * 执行顺序：beforeXxx hooks（顺序） → wrap 链（洋葱） → 实际操作 → afterXxx hooks（顺序）
 */
export class MiddlewarePipeline {
  constructor(private readonly middlewares: AgentMiddleware[]) {}

  // === Hook 执行器 ===

  async runBeforeAgent(ctx: RunContext): Promise<void> {
    for (const mw of this.middlewares) {
      await mw.beforeAgent?.(ctx)
    }
  }

  /** afterAgent 类似 finally：即使前序出错也应执行，确保清理逻辑不被跳过 */
  async runAfterAgent(ctx: RunContext): Promise<void> {
    for (const mw of this.middlewares) {
      try {
        await mw.afterAgent?.(ctx)
      } catch {
        // afterAgent 的异常不向上传播，避免遮盖原始错误
      }
    }
  }

  async runBeforeModel(ctx: RunContext): Promise<void> {
    for (const mw of this.middlewares) {
      await mw.beforeModel?.(ctx)
    }
  }

  async runAfterModel(ctx: RunContext): Promise<void> {
    for (const mw of this.middlewares) {
      await mw.afterModel?.(ctx)
    }
  }

  // === Wrap 链构建器 ===

  /**
   * 构建模型调用 Wrap 链。
   * 从后往前包裹，最先注册的中间件在最外层（先执行）。
   * beforeModel hooks 已在 wrap 链之前执行完毕，重试时不会重复触发。
   */
  buildModelCallChain(baseFn: ModelCallFn): ModelCallFn {
    return this.middlewares.reduceRight<ModelCallFn>((next, mw) => {
      if (!mw.wrapModelCall) return next
      return (ctx) => Promise.resolve(mw.wrapModelCall!(next, ctx))
    }, baseFn)
  }

  /**
   * 构建工具调用 Wrap 链。
   * 结构与模型调用链相同，从后往前包裹。
   */
  buildToolCallChain(baseFn: ToolCallFn): ToolCallFn {
    return this.middlewares.reduceRight<ToolCallFn>((next, mw) => {
      if (!mw.wrapToolCall) return next
      return (ctx) => Promise.resolve(mw.wrapToolCall!(next, ctx))
    }, baseFn)
  }
}

export type { StreamResult, ToolOutput, ToolCallContext }
