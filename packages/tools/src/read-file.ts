import { readFile, stat, readdir } from 'node:fs/promises'
import { resolve, extname, dirname, basename } from 'node:path'
import { z } from 'zod'
import { expandPath, levenshtein } from '@mech-code/shared'
import { defineTool } from '@mech-code/core'
import type { ReadCacheEntry } from '@mech-code/core'

// === 常量 ===

/** 默认单次读取最大字节数 */
const DEFAULT_MAX_SIZE_BYTES = 256 * 1024 // 256 KB

/** 默认单次读取最大 token 数（粗估） */
const DEFAULT_MAX_TOKENS = 16000

/** 默认最大读取行数 */
const DEFAULT_MAX_LINES = 2000

/** 已知二进制文件扩展名（图片类排除，留给多模态处理） */
const BINARY_EXTENSIONS = new Set([
  'exe',
  'dll',
  'so',
  'dylib',
  'bin',
  'obj',
  'o',
  'a',
  'zip',
  'tar',
  'gz',
  'bz2',
  'xz',
  '7z',
  'rar',
  'wasm',
  'class',
  'pyc',
  'pyd',
  'db',
  'sqlite',
  'sqlite3',
  'ico',
  'ttf',
  'otf',
  'woff',
  'woff2',
  'eot',
])

/** 图片扩展名（支持多模态读取） */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

/** 图片文件最大大小限制（1MB） */
const IMAGE_MAX_SIZE_BYTES = 1024 * 1024

/** 会阻塞或产生无限输出的危险设备路径 */
const BLOCKED_DEVICE_PATHS = new Set([
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/full',
  '/dev/stdin',
  '/dev/tty',
  '/dev/console',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/fd/0',
  '/dev/fd/1',
  '/dev/fd/2',
])

// === 辅助函数 ===

/** 格式化文件大小为人类可读格式 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 为内容添加行号前缀（cat -n 风格） */
function addLineNumbers(content: string, startLine: number): string {
  const lines = content.split('\n')
  const maxLineNo = startLine + lines.length - 1
  const width = String(maxLineNo).length
  return lines.map((line, i) => `${String(startLine + i).padStart(width)}\t${line}`).join('\n')
}

/**
 * 文件不存在时，尝试在同目录下找到名称相似的文件。
 * 返回编辑距离最小的建议（阈值 ≤ 3），或 undefined。
 */
async function findSimilarFile(filePath: string): Promise<string | undefined> {
  const dir = dirname(filePath)
  const base = basename(filePath)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return undefined
  }
  let best: { name: string; dist: number } | undefined
  for (const entry of entries) {
    const dist = levenshtein(base, entry)
    if (dist <= 3 && (!best || dist < best.dist)) {
      best = { name: entry, dist }
    }
  }
  return best ? resolve(dir, best.name) : undefined
}

type ReadFileState = Record<string, ReadCacheEntry>

/** 获取 readFileState 缓存（从 store 中取出，惰性初始化） */
function getReadFileState(store: Record<string, unknown>): ReadFileState {
  const state = store['readFileState']
  if (state && typeof state === 'object' && !Array.isArray(state)) {
    return state as ReadFileState
  }
  const next: ReadFileState = {}
  store['readFileState'] = next
  return next
}

/**
 * read_file —— 读取文件内容，支持指定行范围。
 *
 * Phase 1 能力：
 * - offset + limit 分段读取（兼容旧 startLine/endLine）
 * - 路径 ~ 展开
 * - maxSizeBytes 预检
 * - maxTokens 粗估检查
 * - 行号格式化输出
 * - 二进制扩展名拦截
 * - 危险设备路径拦截
 */
export const readFileTool = defineTool({
  name: 'read_file',
  description:
    'Read the contents of a file. Supports line range reading via offset/limit parameters.',
  schema: z.object({
    path: z.string().min(1).describe('File path (relative to cwd or absolute, supports ~)'),
    offset: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Start line number (1-based). Only provide when file is too large to read at once.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Number of lines to read. Only provide when file is too large to read at once.'),
  }),
  flags: { readonly: true, parallelSafe: true },

  getPrompt(ctx) {
    return `读取本地文件系统中的文件内容。

使用说明：
- path 参数支持绝对路径或相对于工作目录（${ctx.cwd}）的相对路径，也支持 ~ 表示主目录
- 默认读取整个文件（上限 ${DEFAULT_MAX_LINES} 行）
- 文件过大时会返回错误提示，此时请使用 offset 和 limit 参数分段读取
- 返回内容带有行号前缀，格式类似 cat -n
- 支持读取图片文件（png/jpg/gif/webp），内容将以视觉方式呈现
- 不支持读取二进制文件（可执行文件、压缩包等）
- 若文件不存在会尝试建议相近的文件名
- 若文件自上次读取后未变化，会返回提示避免重复消耗 token`
  },

  validateInput(input) {
    const rawPath = expandPath(input.path)
    const ext = extname(rawPath).slice(1).toLowerCase()

    // 二进制文件扩展名拦截（图片单独处理）
    if (BINARY_EXTENSIONS.has(ext)) {
      return { valid: false, error: `不支持读取二进制文件 (.${ext})。请使用其他工具处理此类文件。` }
    }

    // 危险设备路径拦截
    if (BLOCKED_DEVICE_PATHS.has(rawPath)) {
      return { valid: false, error: `无法读取设备文件 ${input.path}，该路径会导致阻塞或无限输出。` }
    }

    return { valid: true }
  },

  async execute(input, ctx) {
    // 路径解析：展开 ~，然后相对 cwd 解析
    const resolvedPath = resolve(ctx.cwd, expandPath(input.path))
    const ext = extname(resolvedPath).slice(1).toLowerCase()

    // === 图片文件：多模态读取（Phase 3） ===
    if (IMAGE_EXTENSIONS.has(ext)) {
      let buffer: Buffer
      try {
        buffer = await readFile(resolvedPath)
      } catch (err) {
        if (isEnoent(err)) {
          return { content: await buildNotFoundMessage(resolvedPath, input.path), isError: true }
        }
        const msg = err instanceof Error ? err.message : String(err)
        return { content: `读取文件失败: ${msg}`, isError: true }
      }

      if (buffer.length > IMAGE_MAX_SIZE_BYTES) {
        return {
          content: `图片文件过大 (${formatSize(buffer.length)})，超出 ${formatSize(IMAGE_MAX_SIZE_BYTES)} 限制。`,
          isError: true,
        }
      }

      const mediaType = `image/${ext === 'jpg' ? 'jpeg' : ext}`
      const base64 = buffer.toString('base64')
      return {
        content: `[图片文件: ${basename(resolvedPath)}, ${formatSize(buffer.length)}]`,
        metadata: {
          type: 'image',
          base64,
          mediaType,
          originalSize: buffer.length,
        },
      }
    }

    // === 文本文件处理 ===

    // maxSizeBytes 预检 + stat（同时获取 mtime 用于去重）
    let fileSize: number
    let mtimeMs: number
    try {
      const stats = await stat(resolvedPath)
      fileSize = stats.size
      mtimeMs = stats.mtimeMs
    } catch (err) {
      if (isEnoent(err)) {
        return { content: await buildNotFoundMessage(resolvedPath, input.path), isError: true }
      }
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `读取文件失败: ${msg}`, isError: true }
    }

    if (fileSize > DEFAULT_MAX_SIZE_BYTES) {
      return {
        content:
          `文件过大 (${formatSize(fileSize)})，超出 ${formatSize(DEFAULT_MAX_SIZE_BYTES)} 限制。` +
          `请使用 offset 和 limit 参数分段读取。`,
        isError: true,
      }
    }

    // 重复读取去重检查
    const offset = input.offset ?? 1
    const limit = input.limit
    const readFileState = getReadFileState(ctx.store)
    const cached = readFileState[resolvedPath]
    if (
      cached &&
      cached.offset === offset &&
      cached.limit === limit &&
      cached.timestamp === Math.floor(mtimeMs)
    ) {
      return {
        content: '文件自上次读取后未发生变化，请参考之前的读取结果。',
      }
    }

    // 读取文件
    let rawContent: string
    try {
      rawContent = await readFile(resolvedPath, 'utf-8')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `读取文件失败: ${msg}`, isError: true }
    }

    const allLines = rawContent.split('\n')
    const totalLines = allLines.length

    // 计算读取范围
    const startIdx = offset - 1
    const effectiveLimit = limit ?? Math.min(totalLines - startIdx, DEFAULT_MAX_LINES)
    const endIdx = Math.min(startIdx + effectiveLimit, totalLines)
    const slicedLines = allLines.slice(startIdx, endIdx)
    const content = slicedLines.join('\n')

    // maxTokens 粗估检查
    const estimatedTokens = Math.ceil(content.length / 4)
    if (estimatedTokens > DEFAULT_MAX_TOKENS) {
      return {
        content:
          `文件内容约 ${estimatedTokens} tokens，超出 ${DEFAULT_MAX_TOKENS} 上限。` +
          `文件共 ${totalLines} 行，请使用 offset + limit 缩小读取范围。`,
        isError: true,
      }
    }

    // 更新去重缓存（全文读取时额外存储 content，供 edit_file 做一致性校验）
    const isFullRead = offset === 1 && limit === undefined
    readFileState[resolvedPath] = {
      timestamp: Math.floor(mtimeMs),
      offset,
      limit,
      content: isFullRead ? rawContent : undefined,
    }

    // 格式化输出：header + 带行号内容
    const actualStart = startIdx + 1
    const actualEnd = startIdx + slicedLines.length
    const header = `[${input.path}] lines ${actualStart}-${actualEnd} of ${totalLines}\n\n`
    const numbered = addLineNumbers(content, actualStart)

    return { content: header + numbered }
  },
})

// === 内部辅助 ===

/** 判断错误是否为 ENOENT */
function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
}

/** 构建文件不存在的错误消息，带 fuzzy 建议 */
async function buildNotFoundMessage(resolvedPath: string, inputPath: string): Promise<string> {
  let message = `文件不存在: ${inputPath}`
  const similar = await findSimilarFile(resolvedPath)
  if (similar) {
    message += `\n你是否指的是: ${similar}`
  }
  return message
}
