import type { ProviderConfig } from '@mech-code/core'
import type {
  ContextTrigger,
  KeepStrategy,
  ReactiveCompactOptions,
  SummaryOptions,
  ToolResultBudgetOptions,
  ToolResultCleanupOptions,
} from '@mech-code/middleware'

export interface MechConfig {
  default?: string
  provider?: string
  model?: string
  system?: string
  providers?: Record<string, ProviderConfigEntry>
  contextManagement?: ContextManagementConfig
  mcp?: { servers: Record<string, { command: string; args?: string[] }> }
  skills?: string[]
}

export interface ContextManagementConfig {
  /** 配置块存在时默认启用；显式 false 可关闭。 */
  enabled?: boolean
  /** 可选 context middleware provider 名称；未配置时使用当前 chat provider。 */
  provider?: string
  /** 摘要 provider 名称；未配置时回退 provider/当前 chat provider。 */
  summaryProvider?: string
  modelContextWindow?: number
  reservedOutputTokens?: number
  trigger?: ContextTrigger | ContextTrigger[]
  keep?: KeepStrategy
  summary?: Omit<SummaryOptions, 'sources'>
  toolResults?: ToolResultBudgetOptions
  cleanup?: ToolResultCleanupOptions
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

export function resolveContextManagementConfig(
  config: MechConfig,
): ContextManagementConfig | undefined {
  if (!config.contextManagement) return undefined
  if (config.contextManagement.enabled === false) return undefined
  return config.contextManagement
}
