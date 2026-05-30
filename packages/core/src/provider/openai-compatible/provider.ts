import { OpenAIProvider } from '../openai/provider.js'
import type { ProviderConfig } from '../types.js'

/**
 * OpenAICompatibleProvider — 适用于兼容 OpenAI API 格式的第三方服务。
 *
 * 支持的服务示例：
 * - DeepSeek: baseUrl = 'https://api.deepseek.com'
 * - Ollama: baseUrl = 'http://localhost:11434/v1' （apiKey 设为任意字符串）
 * - vLLM: baseUrl = 'http://your-vllm-host/v1'
 * - 其他 OpenAI 兼容服务
 *
 * 继承 OpenAIProvider 的全部逻辑，只需在 config 中指定 baseUrl。
 */
export class OpenAICompatibleProvider extends OpenAIProvider {
  override readonly name = 'openai-compatible'

  constructor(config: ProviderConfig & { baseUrl: string }) {
    super(config)
  }
}
