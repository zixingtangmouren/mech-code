/**
 * 命令输出处理模块。
 *
 * 负责：
 * 1. 收集 stdout/stderr 并进行字节限制
 * 2. 截断超长输出（首尾保留策略）
 * 3. 格式化组装返回给 LLM 的 content 字符串
 * 4. 从输出中探测 cwd 变化
 */

// === 常量 ===

/** 收集到内存的最大字节数（512 KB） */
export const MAX_OUTPUT_BYTES = 512 * 1024

/** 返回给 LLM 的最大字符数（约 30K） */
export const MAX_CONTENT_CHARS = 30_000

/** 截断时保留的尾部行数（保留末尾的错误信息） */
const TAIL_RESERVE_LINES = 50

/** cwd 探测标记（与 executor.ts 约定） */
export const CWD_MARKER = '__MECH_CWD__'

// === 输出收集器 ===

/**
 * 字节限制的流式输出收集器。
 * 超过限制后停止追加（但不截断已有内容）。
 */
export class BoundedOutputCollector {
  private readonly chunks: Buffer[] = []
  private totalBytes = 0
  private _truncated = false

  /** 是否已触达字节限制 */
  get truncated(): boolean {
    return this._truncated
  }

  /** 已收集的总字节数 */
  get size(): number {
    return this.totalBytes
  }

  /**
   * 追加数据块。超过限制后忽略后续数据。
   */
  append(chunk: Buffer): void {
    if (this._truncated) return

    const remaining = MAX_OUTPUT_BYTES - this.totalBytes
    if (chunk.length <= remaining) {
      this.chunks.push(chunk)
      this.totalBytes += chunk.length
    } else {
      // 只追加能放下的部分
      if (remaining > 0) {
        this.chunks.push(chunk.subarray(0, remaining))
        this.totalBytes += remaining
      }
      this._truncated = true
    }
  }

  /** 将所有数据块合并为字符串（UTF-8 解码） */
  toString(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

// === 截断逻辑 ===

/**
 * 截断结果
 */
export interface TruncateResult {
  /** 截断后的文本内容 */
  content: string
  /** 是否发生了截断 */
  truncated: boolean
  /** 原始总行数 */
  totalLines: number
}

/**
 * 对输出文本进行截断，采用首尾保留策略。
 *
 * 策略：
 * - 若总长度 ≤ maxChars，直接返回原始内容
 * - 否则：保留开头若干行 + 末尾 tailLines 行，中间用省略提示代替
 *
 * @param output 原始输出文本
 * @param maxChars 最大字符数
 * @param tailLines 末尾保留行数
 */
export function truncateOutput(
  output: string,
  maxChars: number = MAX_CONTENT_CHARS,
  tailLines: number = TAIL_RESERVE_LINES,
): TruncateResult {
  if (output.length <= maxChars) {
    return {
      content: output,
      truncated: false,
      totalLines: output ? output.split('\n').length : 0,
    }
  }

  const lines = output.split('\n')
  const totalLines = lines.length

  // 固定分配给末尾部分的字符预算
  const tail = lines.slice(-tailLines)
  const tailStr = tail.join('\n')

  // 省略提示的固定开销（预留 120 字符）
  const ELLIPSIS_BUDGET = 120
  const headBudget = maxChars - tailStr.length - ELLIPSIS_BUDGET

  // 从头部累积到 headBudget
  const headLines: string[] = []
  let headLen = 0
  for (const line of lines) {
    const lineLen = line.length + 1 // +1 for '\n'
    if (headLen + lineLen > headBudget) break
    headLines.push(line)
    headLen += lineLen
  }

  const omitted = totalLines - headLines.length - tail.length
  const ellipsis =
    omitted > 0 ? `\n[... 输出已截断，共 ${totalLines} 行，省略中间 ${omitted} 行 ...]\n` : ''

  const content = headLines.join('\n') + ellipsis + tail.join('\n')

  return { content, truncated: true, totalLines }
}

// === 输出格式化 ===

/**
 * 格式化命令执行结果为返回给 LLM 的 content 字符串。
 */
export interface FormatOutputOptions {
  stdout: string
  stderr: string
  exitCode: number
  /** 是否为语义上的执行错误 */
  isSemanticError: boolean
  /** 是否因超时被杀 */
  timedOut: boolean
  /** 是否因 AbortSignal 被中止 */
  aborted: boolean
  /** 执行耗时（ms） */
  durationMs: number
}

export interface FormatOutputResult {
  /** 最终返回给 LLM 的内容 */
  content: string
  /** 是否为错误状态 */
  isError: boolean
  /** stdout 是否被截断 */
  stdoutTruncated: boolean
}

/**
 * 将执行结果格式化为 LLM 友好的文本。
 */
export function formatOutput(options: FormatOutputOptions): FormatOutputResult {
  const { stdout, stderr, exitCode, isSemanticError, timedOut, aborted, durationMs } = options

  const parts: string[] = []
  let isError = false

  // stdout 部分（截断）
  const stdoutClean = stripCwdMarker(stdout)
  const { content: stdoutContent, truncated: stdoutTruncated } = truncateOutput(stdoutClean)
  if (stdoutContent.trim()) {
    parts.push(stdoutContent)
  }

  // stderr 部分（截断，单独标注）
  if (stderr.trim()) {
    const { content: stderrContent } = truncateOutput(stderr, Math.floor(MAX_CONTENT_CHARS / 3))
    parts.push(`<stderr>\n${stderrContent}\n</stderr>`)
  }

  // 中止/超时/错误标注
  if (timedOut) {
    isError = true
    parts.push(
      `<error>命令执行超时（${durationMs}ms），进程已被终止。Exit code: ${exitCode}</error>`,
    )
  } else if (aborted) {
    isError = true
    parts.push(`<error>命令已被中止。Exit code: ${exitCode}</error>`)
  } else if (isSemanticError) {
    isError = true
    if (exitCode !== 0) {
      parts.push(`Exit code: ${exitCode}`)
    }
  }

  // 空输出时的提示
  if (parts.length === 0) {
    parts.push('（命令执行成功，无输出）')
  }

  return {
    content: parts.join('\n'),
    isError,
    stdoutTruncated,
  }
}

// === cwd 探测 ===

/**
 * 从 stdout 中提取 cwd 探测标记的值。
 * 若不存在标记，返回 null。
 */
export function extractCwdFromOutput(stdout: string): string | null {
  const prefix = `${CWD_MARKER}=`
  const lines = stdout.split('\n')
  // 从末尾往前找，取最后一个（最终 cwd）
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (line.startsWith(prefix)) {
      return line.slice(prefix.length).trim()
    }
  }
  return null
}

/**
 * 从输出中去除 cwd 标记行（避免标记泄露给 LLM）。
 */
function stripCwdMarker(stdout: string): string {
  const prefix = `${CWD_MARKER}=`
  return stdout
    .split('\n')
    .filter((line) => !line.trim().startsWith(prefix))
    .join('\n')
}

/**
 * 包裹命令以追加 cwd 探测后缀。
 * 执行后解析 stdout 即可得到最终工作目录。
 */
export function wrapCommandForCwdDetection(command: string): string {
  return `${command}; echo "${CWD_MARKER}=$(pwd)"`
}

/**
 * 判断命令是否包含 cd，用于决定是否需要探测 cwd。
 */
export function commandContainsCd(command: string): boolean {
  // 匹配独立的 cd 命令（前后为命令分隔符或行首/行尾）
  return /(?:^|[;&|])\s*cd(?:\s|$)/.test(command)
}
