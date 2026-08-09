// === 错误码 ===

export type ProviderErrorCode =
  | 'auth_failed'
  | 'permission_denied'
  | 'billing_error'
  | 'quota_exceeded'
  | 'rate_limited'
  | 'context_too_long'
  | 'model_not_found'
  | 'not_found'
  | 'request_too_large'
  | 'conflict'
  | 'timeout'
  | 'overloaded'
  | 'server_error'
  | 'network_error'
  | 'invalid_response'
  | 'invalid_request'
  | 'aborted'
  | 'unknown'

export interface ProviderErrorOptions {
  retryable?: boolean
  cause?: unknown
  /** HTTP 响应状态码；流内错误可能对应 200。 */
  status?: number
  /** 厂商返回的原始错误 code 或 type。 */
  vendorCode?: string
  requestId?: string
  retryAfterMs?: number
}

// === Provider 统一错误类 ===

/**
 * ProviderError — 所有 LLM Provider 的统一错误类型。
 *
 * Provider 负责归一化错误语义和诊断信息，中间件只负责重试、退避和降级策略。
 */
export class ProviderError extends Error {
  readonly name = 'ProviderError' as const
  readonly retryable: boolean
  override readonly cause?: unknown
  readonly status?: number
  readonly vendorCode?: string
  readonly requestId?: string
  readonly retryAfterMs?: number

  constructor(
    public readonly code: ProviderErrorCode,
    public readonly provider: string,
    message: string,
    options: ProviderErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.retryable = options.retryable ?? false
    this.cause = options.cause
    this.status = options.status
    this.vendorCode = options.vendorCode
    this.requestId = options.requestId
    this.retryAfterMs = options.retryAfterMs
  }

  /** 判断一个错误是否为可重试的 ProviderError */
  static isRetryable(error: unknown): boolean {
    return error instanceof ProviderError && error.retryable
  }
}

/** 通用 HTTP 兜底映射；厂商 Provider 应优先使用结构化错误 code/type。 */
export function httpStatusToCode(status: number, body?: string): ProviderErrorCode {
  switch (status) {
    case 401:
      return 'auth_failed'
    case 402:
      return 'billing_error'
    case 403:
      return 'permission_denied'
    case 404:
      return isModelNotFoundMessage(body) ? 'model_not_found' : 'not_found'
    case 408:
    case 504:
      return 'timeout'
    case 409:
      return 'conflict'
    case 413:
      return 'request_too_large'
    case 429:
      return 'rate_limited'
    case 529:
      return 'overloaded'
    case 400:
      return isContextTooLongMessage(body) ? 'context_too_long' : 'invalid_request'
    default:
      if (status >= 500) return 'server_error'
      return 'invalid_request'
  }
}

export function isRetryableProviderCode(code: ProviderErrorCode): boolean {
  return (
    code === 'rate_limited' ||
    code === 'timeout' ||
    code === 'overloaded' ||
    code === 'server_error' ||
    code === 'network_error'
  )
}

export function isContextTooLongMessage(message: string | undefined): boolean {
  if (!message) return false
  return /context_length_exceeded|maximum context length|context window|prompt is too long/i.test(
    message,
  )
}

export function isModelNotFoundMessage(message: string | undefined): boolean {
  if (!message) return false
  return /model[^\n]*(not found|does not exist)|unknown model|model_not_found/i.test(message)
}
