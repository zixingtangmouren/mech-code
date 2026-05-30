// === 错误码 ===

export type ProviderErrorCode =
  | 'auth_failed' // 401/403
  | 'rate_limited' // 429（可重试）
  | 'context_too_long' // 上下文超限
  | 'model_not_found' // 模型不存在
  | 'server_error' // 5xx（可重试）
  | 'network_error' // 网络层异常（可重试）
  | 'invalid_request' // 4xx 参数错误
  | 'aborted' // 用户主动中止
  | 'unknown' // 未分类错误

// === Provider 统一错误类 ===

/**
 * ProviderError — 所有 LLM Provider 的统一错误类型。
 *
 * Provider 负责将厂商特定的错误（HTTP 状态码、错误响应体）翻译为此类型。
 * 中间件通过 retryable 字段决定是否重试，无需感知具体厂商。
 */
export class ProviderError extends Error {
  readonly name = 'ProviderError' as const

  constructor(
    public readonly code: ProviderErrorCode,
    public readonly provider: string,
    message: string,
    public readonly retryable: boolean = false,
    public readonly cause?: unknown,
  ) {
    super(message)
  }

  /** 判断一个错误是否为可重试的 ProviderError */
  static isRetryable(error: unknown): boolean {
    return error instanceof ProviderError && error.retryable
  }
}

// === HTTP 状态码转换工具 ===

/**
 * 将 HTTP 响应状态码（及可选的响应体文本）映射为 ProviderErrorCode。
 */
export function httpStatusToCode(status: number, body?: string): ProviderErrorCode {
  switch (status) {
    case 401:
    case 403:
      return 'auth_failed'
    case 429:
      return 'rate_limited'
    case 404:
      if (body?.toLowerCase().includes('model')) return 'model_not_found'
      return 'invalid_request'
    case 400:
      if (body?.toLowerCase().includes('context')) return 'context_too_long'
      return 'invalid_request'
    default:
      if (status >= 500) return 'server_error'
      return 'invalid_request'
  }
}
