import type {
  ResolvedToolResultBudgetOptions,
  ResolvedToolResultCleanupOptions,
  ToolResultBudgetOptions,
  ToolResultCleanupOptions,
  ToolResultMiddlewareOptions,
} from './types.js'

const DEFAULT_TOOL_MAX_CHARS = 50_000
const DEFAULT_TOOL_PREVIEW_CHARS = 8_000

export function resolveBudgetOptions(
  options: ToolResultMiddlewareOptions = {},
): ResolvedToolResultBudgetOptions {
  return {
    maxResultChars: options.maxResultChars ?? DEFAULT_TOOL_MAX_CHARS,
    maxResultTokens: options.maxResultTokens ?? Number.POSITIVE_INFINITY,
    previewChars: options.previewChars ?? DEFAULT_TOOL_PREVIEW_CHARS,
    strategy: options.strategy ?? 'preview_only',
    storage: options.storage ?? { type: 'state' },
  }
}

export function resolveCleanupOptions(
  options?: ToolResultCleanupOptions,
): ResolvedToolResultCleanupOptions {
  return {
    maxAgeMs: options?.maxAgeMs,
    replacementText:
      options?.replacementText ??
      'Tool result was cleared by tool result middleware. The original result is no longer visible.',
  }
}

export type { ToolResultBudgetOptions }
