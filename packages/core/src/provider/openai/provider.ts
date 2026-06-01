import type { AssistantContentBlock, Usage } from '@mech-code/shared'
import type { ChatParams, CallOptions, ChatResponse, StreamResult, ModelParams } from '../types.js'
import { BaseProvider, parseSse, wrapFetchError } from '../base.js'
import { OpenAISerializer } from './serializer.js'
import { OpenAIStreamNormalizer } from './normalizer.js'

const DEFAULT_BASE_URL = 'https://api.openai.com'

// === OpenAI Provider ===

export class OpenAIProvider extends BaseProvider {
  readonly name: string = 'openai'

  protected readonly serializer: OpenAISerializer
  protected readonly baseUrl: string

  constructor(config: ConstructorParameters<typeof BaseProvider>[0]) {
    super(config)
    this.serializer = new OpenAISerializer(config.model)
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  }

  async chat(params: ChatParams, options?: CallOptions): Promise<ChatResponse> {
    const merged = this.mergeParams(options?.modelParams)
    const body = this.serializer.serialize(params.messages, {
      system: params.system,
      tools: params.tools,
      modelParams: merged,
    })

    const response = await this.doFetch(
      `${this.baseUrl}/v1/chat/completions`,
      body,
      options?.signal,
    )

    if (!response.ok) throw await this.parseHttpError(response)

    const data = (await response.json()) as OpenAINonStreamResponse
    return this.parseNonStreamResponse(data)
  }

  stream(params: ChatParams, options?: CallOptions): StreamResult {
    const merged = this.mergeParams(options?.modelParams)
    const controller = new AbortController()
    const signal = this.mergeSignals(options?.signal, controller.signal)

    const normalizer = new OpenAIStreamNormalizer()
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

    // 开启流式 + usage 统计
    const response = await this.doFetch(
      `${this.baseUrl}/v1/chat/completions`,
      {
        ...body,
        stream: true,
        stream_options: { include_usage: true },
      },
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

  protected doFetch(url: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.apiKey}`,
        ...this.config.headers,
      },
      body: JSON.stringify(body),
      signal,
    }).catch((err: unknown) => {
      throw wrapFetchError(err, this.name)
    })
  }

  private parseNonStreamResponse(data: OpenAINonStreamResponse): ChatResponse {
    const choice = data.choices[0]!
    const message = choice.message
    const content: AssistantContentBlock[] = []

    if (message.content) {
      content.push({ type: 'text', text: message.content })
    }

    if (message.tool_calls) {
      for (const tc of message.tool_calls) {
        let input: Record<string, unknown> = {}
        try {
          input = JSON.parse(tc.function.arguments) as Record<string, unknown>
        } catch {
          // 参数解析失败时保留空对象
        }
        content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input })
      }
    }

    const usage: Usage = {
      inputTokens: data.usage.prompt_tokens,
      outputTokens: data.usage.completion_tokens,
    }

    return {
      content,
      usage,
      stopReason: this.mapFinishReason(choice.finish_reason ?? 'stop'),
    }
  }

  protected mapFinishReason(reason: string): string {
    switch (reason) {
      case 'stop':
        return 'end_turn'
      case 'tool_calls':
        return 'tool_use'
      case 'length':
        return 'max_tokens'
      case 'content_filter':
        return 'content_filter'
      default:
        return reason
    }
  }
}

// === OpenAI 非流式响应类型 ===

interface OpenAINonStreamResponse {
  choices: Array<{
    message: {
      content: string | null
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: { name: string; arguments: string }
      }>
    }
    finish_reason: string | null
  }>
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}
