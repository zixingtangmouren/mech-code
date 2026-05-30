import type { ProviderConfig } from '@mech/core'

export interface MechConfig {
  default?: string
  provider?: string
  model?: string
  system?: string
  providers?: Record<string, ProviderConfigEntry>
  mcp?: { servers: Record<string, { command: string; args?: string[] }> }
  skills?: string[]
}

export interface ProviderConfigEntry {
  baseUrl?: string
  model: string
  apiKey?: string
  apiKeyEnv?: string
  headers?: Record<string, string>
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
    headers: entry.headers,
  }
}
