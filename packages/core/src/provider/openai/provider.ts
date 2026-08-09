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
import { OpenAISerializer } from './serializer.js'
import { OpenAIStreamNormalizer } from './normalizer.js'
import { OpenAIResponsesSerializer } from './responses-serializer.js'
import {
  OpenAIResponsesStreamNormalizer,
  type OpenAIResponsesNonStreamResponse,
} from './responses-normalizer.js'

const DEFAULT_BASE_URL = 'https://api.openai.com'

// === OpenAI Provider ===

export class OpenAIProvider extends BaseProvider {
  readonly name: string = 'openai'

  protected readonly serializer: OpenAISerializer
  protected readonly responsesSerializer: OpenAIResponsesSerializer
  protected readonly baseUrl: string
  protected readonly protocol: 'chat' | 'responses'

  constructor(config: ConstructorParameters<typeof BaseProvider>[0]) {
    super(config)
    this.serializer = new OpenAISerializer(config.model)
    this.responsesSerializer = new OpenAIResponsesSerializer(config.model)
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
    this.protocol = config.protocol ?? 'chat'
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
      if (this.protocol === 'responses') {
        const body = this.responsesSerializer.serialize(params.messages, {
          system: params.system,
          tools: params.tools,
          modelParams: merged,
        })
        const response = await this.doFetch(`${this.baseUrl}/v1/responses`, body, request.signal)

        if (!response.ok) throw await this.parseHttpError(response)

        const data = await this.parseJsonResponse(response, request.signal)
        this.assertResponsesResponse(data, response)
        if (data.status === 'failed') {
          throw this.createProviderError(
            classifyOpenAIError(response.status, data.error, 'OpenAI response failed'),
            response,
          )
        }
        return this.parseResponsesNonStreamResponse(data)
      }

      const body = this.serializer.serialize(params.messages, {
        system: params.system,
        tools: params.tools,
        modelParams: merged,
      })
      const response = await this.doFetch(
        `${this.baseUrl}/v1/chat/completions`,
        body,
        request.signal,
      )

      if (!response.ok) throw await this.parseHttpError(response)

      const data = await this.parseJsonResponse(response, request.signal)
      this.assertChatResponse(data, response)
      return this.parseNonStreamResponse(data)
    } finally {
      request.cleanup()
    }
  }

  stream(params: ChatParams, options?: CallOptions): StreamResult {
    const merged = this.mergeParams(options?.modelParams)
    const controller = new AbortController()
    const request = this.createRequestSignal(options?.signal, controller.signal, options?.timeoutMs)
    const normalizer =
      this.protocol === 'responses'
        ? new OpenAIResponsesStreamNormalizer()
        : new OpenAIStreamNormalizer()
    const vendorChunks = this.doStream(params, merged, request.signal)
    return this.buildStreamResult(vendorChunks, normalizer, controller, request.cleanup)
  }

  protected override classifyHttpError(context: HttpErrorContext): ProviderErrorDescriptor {
    const envelope = readOpenAIErrorEnvelope(context.data)
    if (!envelope.error) return super.classifyHttpError(context)

    return {
      ...classifyOpenAIError(context.status, envelope.error, context.body),
      requestId: envelope.requestId,
    }
  }

  private async *doStream(
    params: ChatParams,
    merged: ModelParams,
    signal: AbortSignal,
  ): AsyncIterable<unknown> {
    if (this.protocol === 'responses') {
      const body = this.responsesSerializer.serialize(params.messages, {
        system: params.system,
        tools: params.tools,
        modelParams: merged,
      })
      const response = await this.doFetch(
        `${this.baseUrl}/v1/responses`,
        { ...body, stream: true },
        signal,
      )

      if (!response.ok) throw await this.parseHttpError(response)
      yield* this.readSseJson(response, signal, 'responses')
      return
    }

    const body = this.serializer.serialize(params.messages, {
      system: params.system,
      tools: params.tools,
      modelParams: merged,
    })
    const response = await this.doFetch(
      `${this.baseUrl}/v1/chat/completions`,
      { ...body, stream: true, stream_options: { include_usage: true } },
      signal,
    )

    if (!response.ok) throw await this.parseHttpError(response)
    yield* this.readSseJson(response, signal, 'chat')
  }

  private async *readSseJson(
    response: Response,
    signal: AbortSignal,
    protocol: 'chat' | 'responses',
  ): AsyncIterable<unknown> {
    let terminalEventReceived = false
    try {
      for await (const raw of parseSse(response)) {
        let event: unknown
        try {
          event = JSON.parse(raw) as unknown
        } catch (error) {
          throw this.createInvalidResponseError('SSE data is not valid JSON', response, error)
        }

        const streamError = readOpenAIStreamError(event)
        if (streamError) {
          throw this.createProviderError(
            classifyOpenAIError(response.status, streamError.error, 'OpenAI stream failed'),
            response,
          )
        }

        this.assertStreamEvent(event, response, protocol)
        terminalEventReceived = isOpenAITerminalEvent(event, protocol) || terminalEventReceived
        yield event
      }

      if (!terminalEventReceived) {
        throw this.createInvalidResponseError(
          `OpenAI ${protocol} stream ended before a terminal event`,
          response,
        )
      }
    } catch (error) {
      throw wrapFetchError(error, this.name, signal)
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
    }).catch((error: unknown) => {
      throw wrapFetchError(error, this.name, signal)
    })
  }

  private assertChatResponse(
    data: unknown,
    response: Response,
  ): asserts data is OpenAINonStreamResponse {
    const result = openAIChatResponseSchema.safeParse(data)
    if (!result.success) {
      throw this.createInvalidResponseError(
        `Invalid Chat Completions response: ${z.prettifyError(result.error)}`,
        response,
        result.error,
      )
    }
  }

  private assertResponsesResponse(
    data: unknown,
    response: Response,
  ): asserts data is OpenAIResponsesNonStreamResponse {
    const result = openAIResponsesResponseSchema.safeParse(data)
    if (!result.success) {
      throw this.createInvalidResponseError(
        `Invalid Responses response: ${z.prettifyError(result.error)}`,
        response,
        result.error,
      )
    }

    for (const item of result.data.output ?? []) {
      const envelope = openAIResponsesOutputItemEnvelopeSchema.safeParse(item)
      const schema = envelope.success
        ? openAIResponsesOutputItemSchemas[envelope.data.type]
        : undefined
      const itemResult = schema?.safeParse(item) ?? envelope
      if (!itemResult.success) {
        throw this.createInvalidResponseError(
          `Invalid Responses output item: ${z.prettifyError(itemResult.error)}`,
          response,
          itemResult.error,
        )
      }
    }
  }

  private assertStreamEvent(
    event: unknown,
    response: Response,
    protocol: 'chat' | 'responses',
  ): void {
    if (protocol === 'chat') {
      const result = openAIChatChunkSchema.safeParse(event)
      if (result.success) return
      throw this.createInvalidResponseError(
        `Invalid ${protocol} stream event: ${z.prettifyError(result.error)}`,
        response,
        result.error,
      )
    }

    const envelope = openAIResponsesEventEnvelopeSchema.safeParse(event)
    if (!envelope.success) {
      throw this.createInvalidResponseError(
        `Invalid ${protocol} stream event: ${z.prettifyError(envelope.error)}`,
        response,
        envelope.error,
      )
    }
    const schema = openAIResponsesEventSchemas[envelope.data.type]
    const knownEvent = schema?.safeParse(event)
    if (knownEvent && !knownEvent.success) {
      throw this.createInvalidResponseError(
        `Invalid ${protocol} stream event: ${z.prettifyError(knownEvent.error)}`,
        response,
        knownEvent.error,
      )
    }
  }

  private parseNonStreamResponse(data: OpenAINonStreamResponse): ChatResponse {
    const choice = data.choices[0]!
    const content: AssistantContentBlock[] = []

    if (choice.message.content) {
      content.push({ type: 'text', text: choice.message.content })
    }

    for (const toolCall of choice.message.tool_calls ?? []) {
      let input: Record<string, unknown> = {}
      try {
        input = JSON.parse(toolCall.function.arguments) as Record<string, unknown>
      } catch {
        // 参数解析失败时保留空对象，交由工具输入校验反馈给模型
      }
      content.push({
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.function.name,
        input,
      })
    }

    return {
      message: new AssistantMessage(content),
      usage: {
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
      },
      stopReason: this.mapFinishReason(choice.finish_reason ?? 'stop'),
    }
  }

  private parseResponsesNonStreamResponse(data: OpenAIResponsesNonStreamResponse): ChatResponse {
    const content: AssistantContentBlock[] = []
    let text = ''

    for (const item of data.output ?? []) {
      if (item.type === 'message') {
        for (const block of item.content ?? []) {
          if (
            (block.type === 'output_text' || block.type === 'text') &&
            typeof block.text === 'string'
          ) {
            text += block.text
          }
        }
      } else if (item.type === 'reasoning') {
        const reasoningText = [
          ...(item.summary ?? []).map((part) => part.text),
          ...(item.content ?? []).map((part) => part.text),
        ].join('')
        if (reasoningText) content.push({ type: 'thinking', text: reasoningText })
      } else if (item.type === 'function_call') {
        let input: Record<string, unknown> = {}
        try {
          input = item.arguments ? (JSON.parse(item.arguments) as Record<string, unknown>) : {}
        } catch {
          // 参数解析失败时保留空对象，交由工具输入校验反馈给模型
        }
        content.push({
          type: 'tool_use',
          id: item.call_id ?? item.id ?? '',
          name: item.name ?? '',
          input,
        })
      }
    }

    if (text) content.unshift({ type: 'text', text })

    const usage: Usage = {
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    }

    return {
      message: new AssistantMessage(content),
      usage,
      stopReason: content.some((block) => block.type === 'tool_use')
        ? 'tool_use'
        : this.mapResponsesStopReason(data.incomplete_details?.reason, data.status),
    }
  }

  private mapResponsesStopReason(reason: string | null | undefined, status?: string): string {
    if (reason === 'max_output_tokens') return 'max_tokens'
    if (reason) return reason
    if (status === 'incomplete') return 'incomplete'
    return 'end_turn'
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

// === OpenAI 响应校验 ===

const openAIErrorDetailsSchema = z.object({
  message: z.string().optional(),
  type: z.string().nullable().optional(),
  code: z.string().nullable().optional(),
})

const openAIToolCallSchema = z.object({
  id: z.string(),
  function: z.object({ name: z.string(), arguments: z.string() }),
})

const openAIChatResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable(),
          tool_calls: z.array(openAIToolCallSchema).optional(),
        }),
        finish_reason: z.string().nullable(),
      }),
    )
    .min(1),
  usage: z.object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    total_tokens: z.number(),
  }),
})

const openAIChatChunkSchema = z.object({
  choices: z.array(
    z.object({
      index: z.number(),
      delta: z.object({
        content: z.string().nullable().optional(),
        reasoning_content: z.string().nullable().optional(),
        role: z.string().optional(),
        tool_calls: z
          .array(
            z.object({
              index: z.number(),
              id: z.string().optional(),
              type: z.string().optional(),
              function: z
                .object({ name: z.string().optional(), arguments: z.string().optional() })
                .optional(),
            }),
          )
          .optional(),
      }),
      finish_reason: z.string().nullable(),
    }),
  ),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      total_tokens: z.number(),
    })
    .nullable()
    .optional(),
})

const openAIResponsesResponseSchema = z.object({
  output: z.array(z.unknown()),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
    })
    .optional(),
  status: z.string().optional(),
  incomplete_details: z.object({ reason: z.string().nullable().optional() }).nullable().optional(),
  error: openAIErrorDetailsSchema.nullable().optional(),
})

const openAIResponsesEventEnvelopeSchema = z.object({ type: z.string() })

const openAIResponsesOutputItemEnvelopeSchema = z.object({ type: z.string() })

const openAIResponsesOutputItemSchemas: Record<string, z.ZodType> = {
  message: z.object({
    type: z.literal('message'),
    content: z
      .array(
        z.union([
          z.object({ type: z.literal('output_text'), text: z.string() }),
          z.object({ type: z.literal('text'), text: z.string() }),
        ]),
      )
      .optional(),
  }),
  reasoning: z.object({
    type: z.literal('reasoning'),
    summary: z.array(z.object({ type: z.literal('summary_text'), text: z.string() })).optional(),
    content: z.array(z.object({ type: z.literal('reasoning_text'), text: z.string() })).optional(),
  }),
  function_call: z.object({
    type: z.literal('function_call'),
    id: z.string().optional(),
    call_id: z.string().optional(),
    name: z.string(),
    arguments: z.string(),
  }),
}

const openAIResponsesEventSchemas: Record<string, z.ZodType> = {
  'response.output_text.delta': z.object({
    type: z.literal('response.output_text.delta'),
    delta: z.string(),
  }),
  'response.reasoning_summary_text.delta': z.object({
    type: z.literal('response.reasoning_summary_text.delta'),
    delta: z.string(),
  }),
  'response.reasoning_summary_part.done': z.object({
    type: z.literal('response.reasoning_summary_part.done'),
    part: z.object({ type: z.string().optional(), text: z.string().optional() }).optional(),
  }),
  'response.reasoning_text.delta': z.object({
    type: z.literal('response.reasoning_text.delta'),
    delta: z.string(),
  }),
  'response.reasoning_text.done': z.object({
    type: z.literal('response.reasoning_text.done'),
    text: z.string(),
  }),
  'response.output_item.added': z.object({
    type: z.literal('response.output_item.added'),
    output_index: z.number().optional(),
    item: z
      .object({
        type: z.string().optional(),
        id: z.string().optional(),
        call_id: z.string().optional(),
        name: z.string().optional(),
        arguments: z.string().optional(),
      })
      .optional(),
  }),
  'response.function_call_arguments.delta': z.object({
    type: z.literal('response.function_call_arguments.delta'),
    output_index: z.number().optional(),
    item_id: z.string().optional(),
    delta: z.string(),
  }),
  'response.output_item.done': z.object({
    type: z.literal('response.output_item.done'),
    output_index: z.number().optional(),
    item: z
      .object({
        type: z.string().optional(),
        id: z.string().optional(),
        call_id: z.string().optional(),
        name: z.string().optional(),
        arguments: z.string().optional(),
      })
      .optional(),
  }),
  'response.completed': z.object({
    type: z.literal('response.completed'),
    response: openAIResponsesResponseSchema,
  }),
  'response.incomplete': z.object({
    type: z.literal('response.incomplete'),
    response: openAIResponsesResponseSchema,
  }),
}

interface OpenAIErrorDetails {
  message?: string
  type?: string | null
  code?: string | null
}

interface OpenAIErrorEnvelope {
  error?: OpenAIErrorDetails
  requestId?: string
}

function readOpenAIErrorEnvelope(data: unknown): OpenAIErrorEnvelope {
  const record = asRecord(data)
  const parsed = openAIErrorDetailsSchema.safeParse(record?.error)
  return {
    error: parsed.success ? parsed.data : undefined,
    requestId: getString(record, 'request_id'),
  }
}

function readOpenAIStreamError(event: unknown): { error: OpenAIErrorDetails } | undefined {
  const record = asRecord(event)
  if (!record) return undefined

  if (record.type === 'error') {
    const nested = openAIErrorDetailsSchema.safeParse(record.error)
    if (nested.success) return { error: nested.data }
    const direct = openAIErrorDetailsSchema.safeParse(record)
    if (direct.success) return { error: direct.data }
  }

  if (record.type === 'response.failed') {
    const response = asRecord(record.response)
    const parsed = openAIErrorDetailsSchema.safeParse(response?.error)
    if (parsed.success) return { error: parsed.data }
    return { error: { message: 'OpenAI response failed', code: 'server_error' } }
  }

  const envelope = readOpenAIErrorEnvelope(event)
  return envelope.error ? { error: envelope.error } : undefined
}

function isOpenAITerminalEvent(event: unknown, protocol: 'chat' | 'responses'): boolean {
  const record = asRecord(event)
  if (!record) return false
  if (protocol === 'responses') {
    return record.type === 'response.completed' || record.type === 'response.incomplete'
  }

  return Array.isArray(record.choices)
    ? record.choices.some((choice) => {
        const finishReason = asRecord(choice)?.finish_reason
        return typeof finishReason === 'string' && finishReason.length > 0
      })
    : false
}

function classifyOpenAIError(
  status: number,
  error: OpenAIErrorDetails | null | undefined,
  fallbackMessage: string,
): ProviderErrorDescriptor {
  const vendorCode = error?.code ?? error?.type ?? undefined
  const discriminator = `${error?.code ?? ''} ${error?.type ?? ''}`.toLowerCase()
  const message = error?.message || fallbackMessage || `HTTP ${status}`
  let code = httpStatusToCode(status, message)

  if (/insufficient_quota|quota_exceeded|billing|usage_limit|spend_limit/.test(discriminator)) {
    code = 'quota_exceeded'
  } else if (/rate_limit/.test(discriminator)) {
    code = 'rate_limited'
  } else if (/context_length_exceeded/.test(discriminator) || isContextTooLongMessage(message)) {
    code = 'context_too_long'
  } else if (/model_not_found/.test(discriminator) || isModelNotFoundMessage(message)) {
    code = 'model_not_found'
  } else if (/invalid_api_key|authentication/.test(discriminator)) {
    code = 'auth_failed'
  } else if (/permission/.test(discriminator)) {
    code = 'permission_denied'
  } else if (/overload/.test(discriminator)) {
    code = 'overloaded'
  } else if (/timeout/.test(discriminator)) {
    code = 'timeout'
  } else if (/server_error|internal_error/.test(discriminator)) {
    code = 'server_error'
  } else if (status === 200) {
    code = 'invalid_response'
  }

  return { code, message, retryable: isRetryableProviderCode(code), vendorCode }
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

// === OpenAI 非流式响应类型 ===

interface OpenAINonStreamResponse {
  choices: Array<{
    message: {
      content: string | null
      tool_calls?: Array<{
        id: string
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
