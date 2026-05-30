import type { AgentMiddleware, MiddlewareContext, ToolExecContext } from './types.js'

/**
 * 中间件管道执行器（洋葱模型）。
 * 按注册顺序依次执行各中间件钩子。
 */
export class MiddlewarePipeline {
  constructor(private readonly middlewares: AgentMiddleware[]) {}

  async runBeforeLLMCall(ctx: MiddlewareContext): Promise<void> {
    for (const mw of this.middlewares) {
      await mw.beforeLLMCall?.(ctx)
    }
  }

  async runAfterLLMResponse(ctx: MiddlewareContext): Promise<void> {
    for (const mw of this.middlewares) {
      await mw.afterLLMResponse?.(ctx)
    }
  }

  async runBeforeToolExec(ctx: ToolExecContext): Promise<void> {
    for (const mw of this.middlewares) {
      if (ctx.skipExecution) break
      await mw.beforeToolExec?.(ctx)
    }
  }

  async runAfterToolExec(ctx: ToolExecContext): Promise<void> {
    for (const mw of this.middlewares) {
      await mw.afterToolExec?.(ctx)
    }
  }

  async runOnRunStart(ctx: MiddlewareContext): Promise<void> {
    for (const mw of this.middlewares) {
      await mw.onRunStart?.(ctx)
    }
  }

  async runOnTurnEnd(ctx: MiddlewareContext): Promise<void> {
    for (const mw of this.middlewares) {
      await mw.onTurnEnd?.(ctx)
    }
  }

  async runOnRunEnd(ctx: MiddlewareContext): Promise<void> {
    for (const mw of this.middlewares) {
      await mw.onRunEnd?.(ctx)
    }
  }
}
