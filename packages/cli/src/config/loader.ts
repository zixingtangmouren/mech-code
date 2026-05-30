import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { AnthropicProvider, OpenAIProvider, OpenAICompatibleProvider } from '@mech/core'
import type { LLMProvider } from '@mech/core'
import type { MechConfig, ProviderConfigEntry } from './schema.js'
import { resolveProviderConfig } from './schema.js'

/**
 * 加载并合并全局与项目级别的配置文件。
 * 优先级：CLI 参数 > .mech.json（项目级）> ~/.mech/config.json（全局）> 环境变量
 */
export async function loadConfig(): Promise<MechConfig> {
  const globalConfig = await loadJsonFile(join(homedir(), '.mech', 'config.json'))
  const projectConfig = await loadJsonFile(join(process.cwd(), '.mech.json'))

  return {
    ...globalConfig,
    ...projectConfig,
  }
}

/**
 * 根据配置创建 LLM Provider 实例。
 * 自动推断 provider 类型：
 * - 名称包含 anthropic/claude → AnthropicProvider
 * - 名称包含 openai/gpt → OpenAIProvider
 * - 有 baseUrl → OpenAICompatibleProvider
 * - 否则默认 OpenAICompatibleProvider
 */
export function createProviderFromConfig(name: string, entry: ProviderConfigEntry): LLMProvider {
  const config = resolveProviderConfig(entry)
  const lowerName = name.toLowerCase()

  if (lowerName.includes('anthropic') || lowerName.includes('claude')) {
    return new AnthropicProvider({
      apiKey: config.apiKey ?? '',
      model: config.model,
      baseUrl: config.baseUrl,
      defaultParams: { maxTokens: 8192 },
    })
  }

  if (lowerName.includes('openai') || lowerName.includes('gpt')) {
    return new OpenAIProvider({
      apiKey: config.apiKey ?? '',
      model: config.model,
      baseUrl: config.baseUrl,
      defaultParams: {},
    })
  }

  // 带 baseUrl 或其他情况 → 兼容模式
  return new OpenAICompatibleProvider({
    apiKey: config.apiKey ?? '',
    model: config.model,
    baseUrl: config.baseUrl ?? '',
    defaultParams: {},
  })
}

async function loadJsonFile(path: string): Promise<MechConfig> {
  try {
    const content = await readFile(path, 'utf-8')
    return JSON.parse(content) as MechConfig
  } catch {
    return {}
  }
}
