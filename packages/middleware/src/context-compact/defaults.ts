import type { ReactiveCompactOptions, ResolvedReactiveCompactOptions } from './types.js'

export function resolveReactiveOptions(
  options?: ReactiveCompactOptions,
): ResolvedReactiveCompactOptions {
  return {
    enabled: options?.enabled ?? true,
    maxRetries: options?.maxRetries ?? 1,
  }
}
