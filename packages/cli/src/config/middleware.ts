import type { AgentMiddleware, LLMProvider } from '@mech-code/core'
import {
  contextCompactMiddleware,
  todoMiddleware,
  toolResultMiddleware,
} from '@mech-code/middleware'
import type { MechConfig, ProviderConfigEntry } from './schema.js'
import { resolveContextCompactConfig, resolveToolResultConfig } from './schema.js'

export interface BuildCliMiddlewareOptions {
  createProviderFromConfig: (name: string, entry: ProviderConfigEntry) => LLMProvider
}

export class CliMiddlewareConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliMiddlewareConfigError'
  }
}

/**
 * 按最新中间件设计组装 CLI 默认中间件。
 *
 * 注册顺序很重要：先让工具结果中间件投影 Provider 可见内容，
 * 再由上下文压缩中间件基于投影后的消息判断是否 compact。
 */
export function buildCliMiddleware(
  config: MechConfig,
  options: BuildCliMiddlewareOptions,
): AgentMiddleware[] {
  const middleware: AgentMiddleware[] = [todoMiddleware()]

  const toolResult = resolveToolResultConfig(config)
  if (toolResult) {
    middleware.push(
      toolResultMiddleware({
        maxResultChars: toolResult.maxResultChars,
        maxResultTokens: toolResult.maxResultTokens,
        previewChars: toolResult.previewChars,
        strategy: toolResult.strategy,
        storage: toolResult.storage,
        cleanup: toolResult.cleanup,
      }),
    )
  }

  const contextCompact = resolveContextCompactConfig(config)
  if (contextCompact) {
    const summaryProvider = contextCompact.summaryProvider
      ? createSummaryProvider(config, contextCompact.summaryProvider, options)
      : undefined

    middleware.push(
      contextCompactMiddleware({
        summaryProvider,
        modelContextWindow: contextCompact.modelContextWindow,
        trigger: contextCompact.trigger,
        summary: contextCompact.summary,
        reactiveCompact: contextCompact.reactiveCompact,
      }),
    )
  }

  return middleware
}

function createSummaryProvider(
  config: MechConfig,
  name: string,
  options: BuildCliMiddlewareOptions,
): LLMProvider {
  const entry = config.providers?.[name]
  if (!entry) {
    throw new CliMiddlewareConfigError(
      `contextCompact 引用了不存在的 provider "${name}"。\n` +
        `可用 providers: ${Object.keys(config.providers ?? {}).join(', ') || '(无)'}`,
    )
  }

  return options.createProviderFromConfig(name, entry)
}
