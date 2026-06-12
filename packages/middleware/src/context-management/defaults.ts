import type {
  KeepStrategy,
  ReactiveCompactOptions,
  ResolvedReactiveCompactOptions,
  ResolvedToolResultBudgetOptions,
  ResolvedToolResultCleanupOptions,
  ToolResultBudgetOptions,
  ToolResultCleanupOptions,
} from './types.js'

export const DEFAULT_KEEP: KeepStrategy = { messages: 20 }
export const DEFAULT_REACTIVE_KEEP: KeepStrategy = { messages: 8 }

const DEFAULT_TOOL_MAX_CHARS = 50_000
const DEFAULT_TOOL_PREVIEW_CHARS = 8_000

export function resolveToolResultOptions(
  options?: ToolResultBudgetOptions,
): ResolvedToolResultBudgetOptions {
  return {
    maxResultChars: options?.maxResultChars ?? DEFAULT_TOOL_MAX_CHARS,
    maxResultTokens: options?.maxResultTokens ?? Number.POSITIVE_INFINITY,
    previewChars: options?.previewChars ?? DEFAULT_TOOL_PREVIEW_CHARS,
    strategy: options?.strategy ?? 'preview_only',
    storage: options?.storage ?? { type: 'state' },
  }
}

export function resolveCleanupOptions(
  options?: ToolResultCleanupOptions,
): ResolvedToolResultCleanupOptions {
  return {
    enabled: options?.enabled ?? false,
    trigger: options?.trigger ?? {},
    keepRecentToolResults: options?.keepRecentToolResults ?? 10,
    replacementText:
      options?.replacementText ??
      'Tool result was cleared by context management. The original result is no longer visible.',
  }
}

export function resolveReactiveOptions(
  options?: ReactiveCompactOptions,
): ResolvedReactiveCompactOptions {
  return {
    enabled: options?.enabled ?? true,
    maxRetries: options?.maxRetries ?? 1,
    fallbackKeep: options?.fallbackKeep ?? DEFAULT_REACTIVE_KEEP,
  }
}
