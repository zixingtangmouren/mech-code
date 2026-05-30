import type { AssistantContentBlock, Usage } from '@mech/shared'
import type { ChatParams, CallOptions, ChatResponse, StreamResult, ModelParams } from '../types.js'
import { BaseProvider, parseSse, wrapFetchError } from '../base.js'
import { AnthropicSerializer } from './serializer.js'
import { AnthropicStreamNormalizer } from './normalizer.js'

const DEFAULT_BASE_URL = 'https://api.anthropic.com'
const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_MAX_TOKENS = 8192

// === Anthropic Provider ===

export class AnthropicProvider extends BaseProvider {
  readonly name = 'anthropic'

  private readonly serializer: AnthropicSerializer
  private readonly baseUrl: string

  constructor(config: ConstructorParameters<typeof BaseProvider>[0]) {
    super(config)
    this.serializer = new AnthropicSerializer(
      config.model,
      config.defaultParams?.maxTokens ?? DEFAULT_MAX_TOKENS,
    )
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  }

  async chat(params: ChatParams, options?: CallOptions): Promise<ChatResponse> {
    const merged = this.mergeParams(options?.modelParams)
    const body = this.serializer.serialize(params.messages, {
      system: params.system,
      tools: params.tools,
      modelParams: merged,
    })

    const response = await this.doFetch(`${this.baseUrl}/v1/messages`, body, options?.signal)

    if (!response.ok) throw await this.parseHttpError(response)

    const data = (await response.json()) as AnthropicNonStreamResponse
    return this.parseNonStreamResponse(data)
  }

  stream(params: ChatParams, options?: CallOptions): StreamResult {
    const merged = this.mergeParams(options?.modelParams)
    const controller = new AbortController()
    const signal = this.mergeSignals(options?.signal, controller.signal)

    const normalizer = new AnthropicStreamNormalizer()
    const vendorChunks = this.doStream(params, merged, signal)
    return this.buildStreamResult(vendorChunks, normalizer, controller)
  }

  private async *doStream(
    params: ChatParams,
    merged: ModelParams,
    signal: AbortSignal,
  ): AsyncIterable<unknown> {
    const body = this.serializer.serialize(params.messages, {
      system: params.system,
      tools: params.tools,
      modelParams: merged,
    })

    const response = await this.doFetch(
      `${this.baseUrl}/v1/messages`,
      { ...body, stream: true },
      signal,
    )

    if (!response.ok) throw await this.parseHttpError(response)

    for await (const data of parseSse(response)) {
      try {
        yield JSON.parse(data) as unknown
      } catch {
        // 忽略非 JSON 数据行
      }
    }
  }

  private doFetch(url: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        ...this.config.headers,
      },
      body: JSON.stringify(body),
      signal,
    }).catch((err: unknown) => {
      throw wrapFetchError(err, this.name)
    })
  }

  private parseNonStreamResponse(data: AnthropicNonStreamResponse): ChatResponse {
    const content: AssistantContentBlock[] = []

    for (const block of data.content) {
      if (block.type === 'text') {
        content.push({ type: 'text', text: block.text })
      } else if (block.type === 'thinking') {
        content.push({ type: 'thinking', text: block.thinking })
      } else if (block.type === 'tool_use') {
        content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input })
      }
    }

    const usage: Usage = {
      inputTokens: data.usage.input_tokens,
      outputTokens: data.usage.output_tokens,
    }

    return { content, usage, stopReason: data.stop_reason }
  }
}

// === Anthropic 非流式响应类型 ===

interface AnthropicNonStreamResponse {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'thinking'; thinking: string; signature: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  >
  usage: { input_tokens: number; output_tokens: number }
  stop_reason: string
}
