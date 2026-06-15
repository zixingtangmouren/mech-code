import type { ProviderConfig } from '@mech-code/core'
import type {
  ContextTrigger,
  ReactiveCompactOptions,
  SummaryOptions,
  ToolResultMiddlewareOptions,
  ToolResultCleanupOptions,
  ToolResultStorageOptions,
} from '@mech-code/middleware'

export interface MechConfig {
  default?: string
  provider?: string
  model?: string
  system?: string
  providers?: Record<string, ProviderConfigEntry>
  toolResult?: ToolResultConfig
  contextCompact?: ContextCompactConfig
  mcp?: { servers: Record<string, { command: string; args?: string[] }> }
  skills?: string[]
}

export interface ToolResultConfig {
  enabled?: boolean
  maxResultChars?: number
  maxResultTokens?: number
  previewChars?: number
  strategy?: ToolResultMiddlewareOptions['strategy']
  storage?: ToolResultStorageOptions
  cleanup?: ToolResultCleanupOptions
}

export interface ContextCompactConfig {
  enabled?: boolean
  /** 摘要 provider 名称；未配置时回退 provider/当前 chat provider。 */
  summaryProvider?: string
  modelContextWindow?: number
  trigger?: ContextTrigger | ContextTrigger[]
  summary?: Omit<SummaryOptions, 'sources'>
  reactiveCompact?: ReactiveCompactOptions
}

export interface ProviderConfigEntry {
  baseUrl?: string
  model: string
  apiKey?: string
  apiKeyEnv?: string
  protocol?: ProviderConfig['protocol']
  headers?: Record<string, string>
  defaultParams?: ProviderConfig['defaultParams']
}

/**
 * 将 ProviderConfigEntry 解析为 ProviderConfig（包括读取环境变量等）。
 */
export function resolveProviderConfig(entry: ProviderConfigEntry): ProviderConfig {
  const apiKey = entry.apiKey ?? (entry.apiKeyEnv ? (process.env[entry.apiKeyEnv] ?? '') : '')
  return {
    baseUrl: entry.baseUrl,
    model: entry.model,
    apiKey,
    protocol: entry.protocol,
    headers: entry.headers,
    defaultParams: entry.defaultParams,
  }
}

export function resolveToolResultConfig(config: MechConfig): ToolResultConfig | undefined {
  if (!config.toolResult) return undefined
  if (config.toolResult.enabled === false) return undefined
  return config.toolResult
}

export function resolveContextCompactConfig(config: MechConfig): ContextCompactConfig | undefined {
  if (!config.contextCompact) return undefined
  if (config.contextCompact.enabled === false) return undefined
  return config.contextCompact
}
