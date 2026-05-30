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
import { ProviderError, httpStatusToCode } from './errors.js'
import { createStreamResult } from './stream-result.js'

/**
 * BaseProvider — 所有 Provider 实现的抽象基类。
 *
 * 提供共性工具：
 * - mergeParams()：合并 defaultParams 与单次调用 modelParams
 * - parseHttpError()：HTTP 错误响应 → ProviderError
 * - buildStreamResult()：将厂商 chunk 流 + normalizer 组装为 StreamResult
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
    try {
      body = await response.text()
    } catch {
      // 无法读取 body 时忽略
    }
    const code = httpStatusToCode(response.status, body)
    const retryable = code === 'rate_limited' || code === 'server_error'
    return new ProviderError(code, this.name, `HTTP ${response.status}: ${body}`, retryable)
  }

  /** 将厂商 chunk 流 + normalizer 包装为 StreamResult 双通道 */
  protected buildStreamResult<TVendorChunk>(
    vendorChunks: AsyncIterable<TVendorChunk>,
    normalizer: StreamNormalizer<TVendorChunk>,
    controller: AbortController,
  ): StreamResult {
    return createStreamResult({ vendorChunks, normalizer, controller })
  }

  /**
   * 合并多个 AbortSignal。
   * 当外部 signal（用户传入）或内部 controller signal（abort()调用）任一触发时中止。
   * 注：Node 20.3+ 内置 AbortSignal.any()，此处为兼容 TS 类型手动实现。
   */
  protected mergeSignals(external: AbortSignal | undefined, internal: AbortSignal): AbortSignal {
    if (!external) return internal
    // 如果任一已中止，直接返回已中止的 signal
    if (external.aborted) return external
    if (internal.aborted) return internal

    const merged = new AbortController()
    const onAbort = (reason?: unknown): void => merged.abort(reason)
    external.addEventListener('abort', () => onAbort(external.reason), { once: true })
    internal.addEventListener('abort', () => onAbort(internal.reason), { once: true })
    return merged.signal
  }
}

// === SSE 解析工具 ===

/**
 * parseSse — 从 Response 的流式 body 中逐行解析 Server-Sent Events。
 * 每次 yield 一个 `data:` 字段的原始字符串（去除前缀，不含 `[DONE]`）。
 */
export async function* parseSse(response: Response): AsyncIterable<string> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      // 最后一行可能不完整，留在 buffer 中等待下次读取
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim()
          if (data && data !== '[DONE]') yield data
        }
      }
    }

    // 处理 buffer 中的剩余内容
    if (buffer.startsWith('data: ')) {
      const data = buffer.slice(6).trim()
      if (data && data !== '[DONE]') yield data
    }
  } finally {
    reader.releaseLock()
  }
}

/** 将 fetch 层的 AbortError / 网络错误包装为 ProviderError */
export function wrapFetchError(err: unknown, providerName: string): ProviderError {
  if (err instanceof Error && err.name === 'AbortError') {
    return new ProviderError('aborted', providerName, 'Request aborted')
  }
  return new ProviderError('network_error', providerName, String(err), true, err)
}
