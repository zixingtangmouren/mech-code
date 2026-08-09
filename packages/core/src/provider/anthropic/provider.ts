import type { AssistantContentBlock, Usage } from '@mech-code/shared'
import { z } from 'zod'
import type { ChatParams, CallOptions, ChatResponse, StreamResult, ModelParams } from '../types.js'
import {
  BaseProvider,
  parseSse,
  wrapFetchError,
  type HttpErrorContext,
  type ProviderErrorDescriptor,
} from '../base.js'
import {
  httpStatusToCode,
  isContextTooLongMessage,
  isModelNotFoundMessage,
  isRetryableProviderCode,
} from '../errors.js'
import { AssistantMessage } from '../../message/message.js'
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
    const requestController = new AbortController()
    const request = this.createRequestSignal(
      options?.signal,
      requestController.signal,
      options?.timeoutMs,
    )

    try {
      const body = this.serializer.serialize(params.messages, {
        system: params.system,
        tools: params.tools,
        modelParams: merged,
      })
      const response = await this.doFetch(`${this.baseUrl}/v1/messages`, body, request.signal)

      if (!response.ok) throw await this.parseHttpError(response)

      const data = await this.parseJsonResponse(response, request.signal)
      this.assertNonStreamResponse(data, response)
      return this.parseNonStreamResponse(data)
    } finally {
      request.cleanup()
    }
  }

  stream(params: ChatParams, options?: CallOptions): StreamResult {
    const merged = this.mergeParams(options?.modelParams)
    const controller = new AbortController()
    const request = this.createRequestSignal(options?.signal, controller.signal, options?.timeoutMs)
    const normalizer = new AnthropicStreamNormalizer()
    const vendorChunks = this.doStream(params, merged, request.signal)
    return this.buildStreamResult(vendorChunks, normalizer, controller, request.cleanup)
  }

  protected override classifyHttpError(context: HttpErrorContext): ProviderErrorDescriptor {
    const envelope = readAnthropicErrorEnvelope(context.data)
    if (!envelope.error) return super.classifyHttpError(context)

    return {
      ...classifyAnthropicError(context.status, envelope.error, context.body),
      requestId: envelope.requestId,
    }
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

    let messageStopped = false
    try {
      for await (const raw of parseSse(response)) {
        let event: unknown
        try {
          event = JSON.parse(raw) as unknown
        } catch (error) {
          throw this.createInvalidResponseError('SSE data is not valid JSON', response, error)
        }

        const streamError = readAnthropicStreamError(event)
        if (streamError) {
          throw this.createProviderError(
            classifyAnthropicError(response.status, streamError.error, 'Anthropic stream failed'),
            response,
          )
        }

        const envelope = anthropicStreamEventEnvelopeSchema.safeParse(event)
        if (!envelope.success) {
          throw this.createInvalidResponseError(
            `Invalid Anthropic stream event: ${z.prettifyError(envelope.error)}`,
            response,
            envelope.error,
          )
        }
        const schema = anthropicStreamEventSchemas[envelope.data.type]
        const knownEvent = schema?.safeParse(event)
        if (knownEvent && !knownEvent.success) {
          throw this.createInvalidResponseError(
            `Invalid Anthropic stream event: ${z.prettifyError(knownEvent.error)}`,
            response,
            knownEvent.error,
          )
        }
        if (envelope.data.type === 'message_stop') messageStopped = true
        yield event
      }

      if (!messageStopped) {
        throw this.createInvalidResponseError(
          'Anthropic stream ended before message_stop',
          response,
        )
      }
    } catch (error) {
      throw wrapFetchError(error, this.name, signal)
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
    }).catch((error: unknown) => {
      throw wrapFetchError(error, this.name, signal)
    })
  }

  private assertNonStreamResponse(
    data: unknown,
    response: Response,
  ): asserts data is AnthropicNonStreamResponse {
    const parsed = anthropicNonStreamResponseSchema.safeParse(data)
    if (!parsed.success) {
      throw this.createInvalidResponseError(
        `Invalid Anthropic response: ${z.prettifyError(parsed.error)}`,
        response,
        parsed.error,
      )
    }
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

    return {
      message: new AssistantMessage(content),
      usage,
      stopReason: data.stop_reason ?? 'end_turn',
    }
  }
}

// === Anthropic 错误分类 ===

interface AnthropicErrorDetails {
  type?: string
  message?: string
}

interface AnthropicErrorEnvelope {
  error?: AnthropicErrorDetails
  requestId?: string
}

const anthropicErrorDetailsSchema = z.object({
  type: z.string().optional(),
  message: z.string().optional(),
})

function readAnthropicErrorEnvelope(data: unknown): AnthropicErrorEnvelope {
  const record = asRecord(data)
  const parsed = anthropicErrorDetailsSchema.safeParse(record?.error)
  return {
    error: parsed.success ? parsed.data : undefined,
    requestId: getString(record, 'request_id'),
  }
}

function readAnthropicStreamError(event: unknown): { error: AnthropicErrorDetails } | undefined {
  const record = asRecord(event)
  if (record?.type !== 'error') return undefined
  const parsed = anthropicErrorDetailsSchema.safeParse(record.error)
  return parsed.success ? { error: parsed.data } : undefined
}

function classifyAnthropicError(
  status: number,
  error: AnthropicErrorDetails,
  fallbackMessage: string,
): ProviderErrorDescriptor {
  const vendorCode = error.type
  const discriminator = error.type?.toLowerCase() ?? ''
  const message = error.message || fallbackMessage || `HTTP ${status}`
  let code = httpStatusToCode(status, message)

  if (discriminator === 'authentication_error') {
    code = 'auth_failed'
  } else if (discriminator === 'permission_error') {
    code = 'permission_denied'
  } else if (discriminator === 'billing_error') {
    code = 'billing_error'
  } else if (discriminator === 'rate_limit_error') {
    code = 'rate_limited'
  } else if (discriminator === 'request_too_large') {
    code = 'request_too_large'
  } else if (discriminator === 'overloaded_error') {
    code = 'overloaded'
  } else if (discriminator === 'api_error') {
    code = 'server_error'
  } else if (discriminator === 'not_found_error') {
    code = isModelNotFoundMessage(message) ? 'model_not_found' : 'not_found'
  } else if (discriminator === 'invalid_request_error' && isContextTooLongMessage(message)) {
    code = 'context_too_long'
  } else if (status === 200) {
    code = 'invalid_response'
  }

  return { code, message, retryable: isRetryableProviderCode(code), vendorCode }
}

// === Anthropic 响应校验 ===

const anthropicContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('thinking'), thinking: z.string(), signature: z.string().optional() }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
  }),
  z.object({ type: z.literal('redacted_thinking'), data: z.string() }),
])

const anthropicNonStreamResponseSchema = z.object({
  content: z.array(anthropicContentBlockSchema),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
  stop_reason: z.string().nullable(),
})

const anthropicStreamEventEnvelopeSchema = z.object({ type: z.string() })

const anthropicStreamEventSchemas: Record<string, z.ZodType> = {
  message_start: z.object({
    type: z.literal('message_start'),
    message: z.object({
      usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
    }),
  }),
  content_block_start: z.object({
    type: z.literal('content_block_start'),
    index: z.number(),
    content_block: z.discriminatedUnion('type', [
      z.object({ type: z.literal('text'), text: z.string() }),
      z.object({ type: z.literal('thinking'), thinking: z.string() }),
      z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string() }),
    ]),
  }),
  content_block_delta: z.object({
    type: z.literal('content_block_delta'),
    index: z.number(),
    delta: z.discriminatedUnion('type', [
      z.object({ type: z.literal('text_delta'), text: z.string() }),
      z.object({ type: z.literal('thinking_delta'), thinking: z.string() }),
      z.object({ type: z.literal('input_json_delta'), partial_json: z.string() }),
    ]),
  }),
  content_block_stop: z.object({ type: z.literal('content_block_stop'), index: z.number() }),
  message_delta: z.object({
    type: z.literal('message_delta'),
    delta: z.object({ stop_reason: z.string().nullable(), stop_sequence: z.string().nullable() }),
    usage: z.object({ output_tokens: z.number() }),
  }),
  message_stop: z.object({ type: z.literal('message_stop') }),
  ping: z.object({ type: z.literal('ping') }),
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined
}

function getString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' ? value : undefined
}

interface AnthropicNonStreamResponse {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'thinking'; thinking: string; signature?: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    | { type: 'redacted_thinking'; data: string }
  >
  usage: { input_tokens: number; output_tokens: number }
  stop_reason: string | null
}
