import type {
  LLMProvider,
  ChatParams,
  CallOptions,
  ChatResponse,
  StreamResult,
  ModelParams,
  ProviderConfig,
  StreamNormalizer,
} from './types.js'
import {
  ProviderError,
  httpStatusToCode,
  isRetryableProviderCode,
  type ProviderErrorCode,
} from './errors.js'
import { createStreamResult } from './stream-result.js'

const DEFAULT_TIMEOUT_MS = 300_000

export interface HttpErrorContext {
  status: number
  body: string
  data: unknown
}

export interface ProviderErrorDescriptor {
  code: ProviderErrorCode
  message: string
  retryable?: boolean
  vendorCode?: string
  requestId?: string
}

interface RequestSignal {
  signal: AbortSignal
  cleanup: () => void
}

/**
 * BaseProvider — 所有 Provider 实现的抽象基类。
 *
 * 提供参数合并、响应读取、公共错误元数据提取、超时信号和流结果组装。
 */
export abstract class BaseProvider implements LLMProvider {
  abstract readonly name: string

  constructor(protected readonly config: ProviderConfig) {}

  abstract chat(params: ChatParams, options?: CallOptions): Promise<ChatResponse>
  abstract stream(params: ChatParams, options?: CallOptions): StreamResult

  /** 浅合并 defaultParams 与单次调用覆盖参数 */
  protected mergeParams(override?: ModelParams): ModelParams {
    return { ...this.config.defaultParams, ...override }
  }

  /** 解析 HTTP 错误响应为统一的 ProviderError */
  protected async parseHttpError(response: Response): Promise<ProviderError> {
    let body = ''
    let readCause: unknown
    try {
      body = await response.text()
    } catch (error) {
      readCause = error
    }

    const data = tryParseJson(body)
    const descriptor = this.classifyHttpError({ status: response.status, body, data })
    return this.createProviderError(descriptor, response, readCause)
  }

  /** 厂商 Provider 可覆盖此方法，优先根据结构化错误 code/type 分类。 */
  protected classifyHttpError(context: HttpErrorContext): ProviderErrorDescriptor {
    const code = httpStatusToCode(context.status, context.body)
    return {
      code,
      message: (getErrorMessage(context.data) ?? context.body) || `HTTP ${context.status}`,
      retryable: isRetryableProviderCode(code),
      vendorCode: getVendorCode(context.data),
      requestId: getRequestId(context.data),
    }
  }

  /** 读取成功响应 JSON，并把解析或传输失败归一化。 */
  protected async parseJsonResponse(response: Response, signal?: AbortSignal): Promise<unknown> {
    try {
      return await response.json()
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw wrapFetchError(error, this.name, signal)
      throw this.createInvalidResponseError('Response body is not valid JSON', response, error)
    }
  }

  protected createInvalidResponseError(
    message: string,
    response?: Response,
    cause?: unknown,
  ): ProviderError {
    return this.createProviderError(
      { code: 'invalid_response', message, retryable: false },
      response,
      cause,
    )
  }

  protected createProviderError(
    descriptor: ProviderErrorDescriptor,
    response?: Response,
    cause?: unknown,
  ): ProviderError {
    return new ProviderError(descriptor.code, this.name, descriptor.message, {
      retryable: descriptor.retryable ?? isRetryableProviderCode(descriptor.code),
      cause,
      status: response?.status,
      vendorCode: descriptor.vendorCode,
      requestId:
        response?.headers.get('x-request-id') ??
        response?.headers.get('request-id') ??
        descriptor.requestId,
      retryAfterMs: response ? parseRetryAfter(response.headers.get('retry-after')) : undefined,
    })
  }

  /** 创建同时响应外部取消、主动 abort 和请求超时的信号。 */
  protected createRequestSignal(
    external: AbortSignal | undefined,
    internal: AbortSignal,
    timeoutOverride?: number,
  ): RequestSignal {
    const controller = new AbortController()
    const signals = external ? [external, internal] : [internal]
    const listeners: Array<{ signal: AbortSignal; listener: () => void }> = []
    const timeoutMs = timeoutOverride ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    let timeout: ReturnType<typeof setTimeout> | undefined

    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout)
      for (const item of listeners) {
        item.signal.removeEventListener('abort', item.listener)
      }
    }

    const abortFrom = (signal: AbortSignal): void => {
      if (!controller.signal.aborted) {
        controller.abort(signal.reason)
        cleanup()
      }
    }

    for (const signal of signals) {
      if (signal.aborted) {
        abortFrom(signal)
        break
      }
      const listener = (): void => abortFrom(signal)
      signal.addEventListener('abort', listener, { once: true })
      listeners.push({ signal, listener })
    }

    if (!controller.signal.aborted) {
      timeout = setTimeout(() => {
        controller.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, 'TimeoutError'))
        cleanup()
      }, timeoutMs)
      timeout.unref?.()
    }

    return {
      signal: controller.signal,
      cleanup,
    }
  }

  /** 将厂商 chunk 流 + normalizer 包装为 StreamResult 双通道 */
  protected buildStreamResult<TVendorChunk>(
    vendorChunks: AsyncIterable<TVendorChunk>,
    normalizer: StreamNormalizer<TVendorChunk>,
    controller: AbortController,
    cleanup?: () => void,
  ): StreamResult {
    return createStreamResult({ vendorChunks, normalizer, controller, cleanup })
  }
}

// === SSE 解析工具 ===

/** 从 Response 的流式 body 中逐行解析 Server-Sent Events。 */
export async function* parseSse(response: Response): AsyncIterable<string> {
  if (!response.body) throw new TypeError('Response body is empty')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const data = parseSseDataLine(line)
        if (data !== undefined && data !== '[DONE]') yield data
      }
    }

    const remaining = parseSseDataLine(buffer)
    if (remaining !== undefined && remaining !== '[DONE]') yield remaining
  } finally {
    reader.releaseLock()
  }
}

/** 将 fetch 和响应体读取异常包装为统一错误。 */
export function wrapFetchError(
  error: unknown,
  providerName: string,
  signal?: AbortSignal,
): ProviderError {
  if (error instanceof ProviderError) return error

  const reason: unknown = signal?.aborted ? (signal.reason as unknown) : error
  if (reason instanceof Error && reason.name === 'TimeoutError') {
    return new ProviderError('timeout', providerName, reason.message || 'Request timed out', {
      retryable: true,
      cause: error,
    })
  }
  if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
    return new ProviderError('aborted', providerName, 'Request aborted', { cause: error })
  }

  const message = error instanceof Error ? error.message : String(error)
  return new ProviderError('network_error', providerName, message, {
    retryable: true,
    cause: error,
  })
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)

  const date = Date.parse(value)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, date - Date.now())
}

function parseSseDataLine(line: string): string | undefined {
  const normalized = line.endsWith('\r') ? line.slice(0, -1) : line
  if (!normalized.startsWith('data:')) return undefined
  const value = normalized.slice(5)
  const data = value.startsWith(' ') ? value.slice(1) : value
  return data.trim()
}

function tryParseJson(body: string): unknown {
  if (!body) return undefined
  try {
    return JSON.parse(body) as unknown
  } catch {
    return undefined
  }
}

function getErrorMessage(data: unknown): string | undefined {
  const record = asRecord(data)
  const error = asRecord(record?.error)
  return getString(error, 'message') ?? getString(record, 'message')
}

function getVendorCode(data: unknown): string | undefined {
  const error = asRecord(asRecord(data)?.error)
  return getString(error, 'code') ?? getString(error, 'type')
}

function getRequestId(data: unknown): string | undefined {
  return getString(asRecord(data), 'request_id')
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
