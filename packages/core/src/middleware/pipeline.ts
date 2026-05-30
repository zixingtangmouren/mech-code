import type {
  AgentMiddleware,
  RunContext,
  ToolExecContext,
  LLMCallFn,
  ToolExecFn,
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

  async runOnRunStart(ctx: RunContext): Promise<void> {
    for (const mw of this.middlewares) {
      await mw.onRunStart?.(ctx)
    }
  }

  async runOnTurnEnd(ctx: RunContext): Promise<void> {
    for (const mw of this.middlewares) {
      await mw.onTurnEnd?.(ctx)
    }
  }

  /** onRunEnd 类似 finally：即使前序出错也应执行，确保清理逻辑不被跳过 */
  async runOnRunEnd(ctx: RunContext): Promise<void> {
    for (const mw of this.middlewares) {
      try {
        await mw.onRunEnd?.(ctx)
      } catch {
        // onRunEnd 的异常不向上传播，避免遮盖原始错误
      }
    }
  }

  async runBeforeLLMCall(ctx: RunContext): Promise<void> {
    for (const mw of this.middlewares) {
      await mw.beforeLLMCall?.(ctx)
    }
  }

  async runAfterLLMResponse(ctx: RunContext): Promise<void> {
    for (const mw of this.middlewares) {
      await mw.afterLLMResponse?.(ctx)
    }
  }

  async runBeforeToolExec(ctx: ToolExecContext): Promise<void> {
    for (const mw of this.middlewares) {
      // 某个中间件设置 skipExecution 后，后续中间件的 beforeToolExec 不再执行
      if (ctx.skipExecution) break
      await mw.beforeToolExec?.(ctx)
    }
  }

  async runAfterToolExec(ctx: ToolExecContext): Promise<void> {
    for (const mw of this.middlewares) {
      await mw.afterToolExec?.(ctx)
    }
  }

  // === Wrap 链构建器 ===

  /**
   * 构建 LLM 调用 Wrap 链。
   * 从后往前包裹，最先注册的中间件在最外层（先执行）。
   * beforeLLMCall hooks 已在 wrap 链之前执行完毕，重试时不会重复触发。
   */
  buildLLMCallChain(baseFn: LLMCallFn): LLMCallFn {
    return this.middlewares.reduceRight<LLMCallFn>((next, mw) => {
      if (!mw.wrapLLMCall) return next
      return (ctx) => Promise.resolve(mw.wrapLLMCall!(next, ctx))
    }, baseFn)
  }

  /**
   * 构建工具执行 Wrap 链。
   * 结构与 LLM 调用链相同，从后往前包裹。
   */
  buildToolExecChain(baseFn: ToolExecFn): ToolExecFn {
    return this.middlewares.reduceRight<ToolExecFn>((next, mw) => {
      if (!mw.wrapToolExec) return next
      return (ctx) => Promise.resolve(mw.wrapToolExec!(next, ctx))
    }, baseFn)
  }
}

// 保留旧方法签名的类型兼容（供过渡期使用）
export type { StreamResult, ToolOutput }
