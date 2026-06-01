import { readFile, writeFile, stat, mkdir, readdir } from 'node:fs/promises'
import { resolve, dirname, basename } from 'node:path'
import { z } from 'zod'
import { expandPath, levenshtein } from '@mech-code/shared'
import { defineTool } from '../define.js'
import type { ReadCacheEntry } from '../types.js'

// === 常量 ===

/** 可编辑文件的最大大小（10 MB） */
const MAX_EDIT_FILE_SIZE = 10 * 1024 * 1024

/** 弯引号常量 */
const LEFT_SINGLE_CURLY = '\u2018' // '
const RIGHT_SINGLE_CURLY = '\u2019' // '
const LEFT_DOUBLE_CURLY = '\u201c' // "
const RIGHT_DOUBLE_CURLY = '\u201d' // "

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

/** 统计子字符串出现次数 */
function countOccurrences(text: string, search: string): number {
  let count = 0
  let pos = 0
  while (true) {
    pos = text.indexOf(search, pos)
    if (pos === -1) break
    count++
    pos += 1
  }
  return count
}

/** 判断错误是否为 ENOENT */
function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
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

/** 获取 readFileState 缓存（从 metadata 中取出） */
function getReadFileState(
  metadata: Record<string, unknown>,
): Map<string, ReadCacheEntry> | undefined {
  const state = metadata['__readFileState']
  if (state instanceof Map) return state as Map<string, ReadCacheEntry>
  return undefined
}

/**
 * 匹配失败时，尝试诊断部分匹配位置，帮助 LLM 修正。
 */
function buildMismatchDiagnostic(fileContent: string, oldString: string): string {
  const lines = oldString.split('\n')
  if (lines.length <= 1) {
    return '未找到匹配。请确认文件路径和内容是否正确。'
  }
  // 从后往前缩减，找到能匹配的最长前缀
  for (let i = lines.length - 1; i >= 1; i--) {
    const partial = lines.slice(0, i).join('\n')
    if (fileContent.includes(partial)) {
      return `前 ${i} 行可以匹配，但第 ${i + 1} 行开始不匹配。请检查缩进或内容差异。`
    }
  }
  return '未找到任何部分匹配。请确认文件路径和内容是否正确。'
}

// === 引号标准化 ===

/**
 * 将弯引号标准化为直引号。
 * LLM 输出直引号，但文件中可能使用弯引号。
 */
function normalizeQuotes(str: string): string {
  return str
    .replaceAll(LEFT_SINGLE_CURLY, "'")
    .replaceAll(RIGHT_SINGLE_CURLY, "'")
    .replaceAll(LEFT_DOUBLE_CURLY, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY, '"')
}

/**
 * 在文件内容中查找实际匹配的字符串，支持引号标准化容错。
 * 精确匹配优先；若精确匹配失败，尝试标准化引号后重新匹配。
 * 返回文件中实际的字符串（可能含弯引号），或 null 表示未找到。
 */
function findActualString(fileContent: string, searchString: string): string | null {
  // 精确匹配优先
  if (fileContent.includes(searchString)) {
    return searchString
  }
  // 标准化引号后重试
  const normalizedSearch = normalizeQuotes(searchString)
  const normalizedFile = normalizeQuotes(fileContent)
  const idx = normalizedFile.indexOf(normalizedSearch)
  if (idx !== -1) {
    // 返回文件中对应位置的原始字符串
    return fileContent.substring(idx, idx + normalizedSearch.length)
  }
  return null
}

/**
 * 判断字符是否处于「开引号」上下文（前一个字符是空白或开括号）。
 */
function isOpeningContext(chars: string[], index: number): boolean {
  if (index === 0) return true
  const prev = chars[index - 1]
  return (
    prev === ' ' ||
    prev === '\t' ||
    prev === '\n' ||
    prev === '\r' ||
    prev === '(' ||
    prev === '[' ||
    prev === '{' ||
    prev === '\u2014' || // em dash
    prev === '\u2013' // en dash
  )
}

/**
 * 当通过引号标准化匹配成功时，将 new_string 中的直引号转换为文件原有的弯引号风格，
 * 保持排版一致性。
 */
function preserveQuoteStyle(oldString: string, actualOldString: string, newString: string): string {
  // 如果两者相同，没有发生标准化
  if (oldString === actualOldString) return newString

  const hasDouble =
    actualOldString.includes(LEFT_DOUBLE_CURLY) || actualOldString.includes(RIGHT_DOUBLE_CURLY)
  const hasSingle =
    actualOldString.includes(LEFT_SINGLE_CURLY) || actualOldString.includes(RIGHT_SINGLE_CURLY)

  if (!hasDouble && !hasSingle) return newString

  let result = newString
  if (hasDouble) result = applyCurlyDoubleQuotes(result)
  if (hasSingle) result = applyCurlySingleQuotes(result)
  return result
}

/** 将直双引号转换为弯双引号 */
function applyCurlyDoubleQuotes(str: string): string {
  const chars = [...str]
  const result: string[] = []
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '"') {
      result.push(isOpeningContext(chars, i) ? LEFT_DOUBLE_CURLY : RIGHT_DOUBLE_CURLY)
    } else {
      result.push(chars[i]!)
    }
  }
  return result.join('')
}

/** 将直单引号转换为弯单引号（缩略词中的撇号使用右弯引号） */
function applyCurlySingleQuotes(str: string): string {
  const chars = [...str]
  const result: string[] = []
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "'") {
      // 缩略词检测：前后都是字母时视为撇号
      const prev = i > 0 ? chars[i - 1] : undefined
      const next = i < chars.length - 1 ? chars[i + 1] : undefined
      const prevIsLetter = prev !== undefined && /\p{L}/u.test(prev)
      const nextIsLetter = next !== undefined && /\p{L}/u.test(next)
      if (prevIsLetter && nextIsLetter) {
        result.push(RIGHT_SINGLE_CURLY) // 撇号用右弯引号
      } else {
        result.push(isOpeningContext(chars, i) ? LEFT_SINGLE_CURLY : RIGHT_SINGLE_CURLY)
      }
    } else {
      result.push(chars[i]!)
    }
  }
  return result.join('')
}

// === 工具定义 ===

/**
 * edit_file —— 通过精确字符串匹配进行文件编辑。
 *
 * Phase 1 能力：
 * - replace_all 批量替换
 * - old_string = "" 创建/追加语义
 * - 读前置校验（must read before edit）
 * - 文件修改时间戳校验
 * - 编辑后更新 readFileState
 * - 文件大小预检
 * - 匹配失败诊断
 * - 路径 ~ 展开
 *
 * Phase 2 能力：
 * - 引号标准化匹配（直引号 ↔ 弯引号容错）
 * - preserveQuoteStyle（保持文件原有引号风格）
 * - 删除时尾随换行清理
 */
export const editFileTool = defineTool({
  name: 'edit_file',
  description:
    'Edit a file by replacing an exact string match. Supports single replacement (default) or replacing all occurrences with replace_all. Use empty old_string to create a new file.',
  schema: z.object({
    path: z.string().min(1).describe('File path (relative to cwd or absolute, supports ~)'),
    old_string: z.string().describe('The exact text to find. Empty string means create new file.'),
    new_string: z.string().describe('The replacement text'),
    replace_all: z
      .boolean()
      .optional()
      .default(false)
      .describe('Replace all occurrences (default false, requires unique match)'),
  }),
  flags: { readonly: false, parallelSafe: false },

  getPrompt(ctx) {
    return `通过精确字符串匹配编辑文件内容。

使用说明：
- 必须先使用 read_file 读取文件，再进行编辑
- path 参数支持绝对路径或相对于工作目录（${ctx.cwd}）的相对路径，也支持 ~ 表示主目录
- old_string 必须与文件中的内容完全一致（包括缩进、空格、换行）
- 注意 read_file 返回的行号前缀不是文件内容的一部分，不要包含在 old_string 中
- old_string 不唯一时会报错。请提供更多上下文行使其唯一，或使用 replace_all 替换所有出现
- 使用最小的 old_string 足以唯一定位即可（通常 2-4 行上下文够了）
- old_string 为空字符串时表示创建新文件（文件不得已存在）
- replace_all 适用于变量重命名等需要全局替换的场景
- 优先编辑现有文件，避免不必要地创建新文件`
  },

  validateInput(input) {
    // old_string 和 new_string 相同则无意义
    if (input.old_string !== '' && input.old_string === input.new_string) {
      return { valid: false, error: 'old_string 与 new_string 完全相同，无需编辑。' }
    }

    // 危险设备路径拦截
    const rawPath = expandPath(input.path)
    if (BLOCKED_DEVICE_PATHS.has(rawPath)) {
      return { valid: false, error: `无法编辑设备文件 ${input.path}。` }
    }

    return { valid: true }
  },

  async execute(input, ctx) {
    // 路径解析：展开 ~，然后相对 cwd 解析
    const resolvedPath = resolve(ctx.cwd, expandPath(input.path))
    const readFileState = getReadFileState(ctx.metadata)

    // === old_string 为空：创建新文件 / 向空文件写入 ===
    if (input.old_string === '') {
      return await handleCreateOrAppend(resolvedPath, input.path, input.new_string, readFileState)
    }

    // === 文件大小预检 ===
    let fileSize: number
    let mtimeMs: number
    try {
      const stats = await stat(resolvedPath)
      fileSize = stats.size
      mtimeMs = stats.mtimeMs
    } catch (err) {
      if (isEnoent(err)) {
        return await buildNotFoundMessage(resolvedPath, input.path)
      }
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `读取文件失败: ${msg}`, isError: true }
    }

    if (fileSize > MAX_EDIT_FILE_SIZE) {
      return {
        content: `文件过大 (${formatSize(fileSize)})，超出编辑限制 (${formatSize(MAX_EDIT_FILE_SIZE)})。`,
        isError: true,
      }
    }

    // === 读前置校验 ===
    if (readFileState && !readFileState.has(resolvedPath)) {
      return {
        content: '文件尚未被读取。请先使用 read_file 读取文件内容，再进行编辑。',
        isError: true,
      }
    }

    // === 时间戳校验 ===
    if (readFileState) {
      const cached = readFileState.get(resolvedPath)
      if (cached && Math.floor(mtimeMs) > cached.timestamp) {
        // 兜底：若缓存了内容，对比内容是否真的变了
        if (cached.content !== undefined) {
          let currentContent: string
          try {
            currentContent = await readFile(resolvedPath, 'utf-8')
          } catch {
            return {
              content: '文件自上次读取后已被外部修改。请重新读取后再编辑。',
              isError: true,
            }
          }
          if (currentContent !== cached.content) {
            return {
              content: '文件自上次读取后已被外部修改。请重新读取后再编辑。',
              isError: true,
            }
          }
          // 内容未变，mtime 变化是误报（如编辑器 auto-save），继续执行
        } else {
          return {
            content: '文件自上次读取后已被外部修改。请重新读取后再编辑。',
            isError: true,
          }
        }
      }
    }

    // === 读取文件内容 ===
    let content: string
    try {
      content = await readFile(resolvedPath, 'utf-8')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `读取文件失败: ${msg}`, isError: true }
    }

    // === 匹配与替换 ===
    // 使用引号标准化容错查找实际匹配字符串
    const actualOldString = findActualString(content, input.old_string)

    if (!actualOldString) {
      const diagnostic = buildMismatchDiagnostic(content, input.old_string)
      return {
        content: `编辑失败: 在 ${input.path} 中未找到指定的 old_string。\n${diagnostic}`,
        isError: true,
      }
    }

    const occurrences = countOccurrences(content, actualOldString)

    if (occurrences > 1 && !input.replace_all) {
      return {
        content:
          `编辑失败: old_string 在 ${input.path} 中匹配了 ${occurrences} 次，` +
          `必须恰好匹配 1 次。请提供更多上下文以确保唯一匹配，或设置 replace_all 为 true。`,
        isError: true,
      }
    }

    // 保持文件原有的引号风格
    const actualNewString = preserveQuoteStyle(input.old_string, actualOldString, input.new_string)

    // 执行替换（删除时清理尾随换行）
    let newContent: string
    if (input.replace_all) {
      newContent = content.replaceAll(actualOldString, actualNewString)
    } else if (actualNewString === '') {
      // 删除模式：若 old_string 后紧跟换行，连同换行一起删除
      const stripTrailingNewline =
        !actualOldString.endsWith('\n') && content.includes(actualOldString + '\n')
      newContent = stripTrailingNewline
        ? content.replace(actualOldString + '\n', '')
        : content.replace(actualOldString, '')
    } else {
      newContent = content.replace(actualOldString, actualNewString)
    }

    // === 写入磁盘 ===
    try {
      await writeFile(resolvedPath, newContent, 'utf-8')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `写入文件失败: ${msg}`, isError: true }
    }

    // === 更新 readFileState ===
    if (readFileState) {
      try {
        const newMtime = (await stat(resolvedPath)).mtimeMs
        readFileState.set(resolvedPath, {
          timestamp: Math.floor(newMtime),
          offset: undefined,
          limit: undefined,
          content: newContent,
        })
      } catch {
        // stat 失败不影响编辑结果
      }
    }

    // === 返回结果 ===
    const replacedCount = input.replace_all ? occurrences : 1
    const countNote = replacedCount > 1 ? `（替换了 ${replacedCount} 处匹配）` : ''
    return { content: `已编辑 ${input.path}${countNote}` }
  },
})

// === 内部辅助 ===

/**
 * 处理 old_string = "" 的情况：创建新文件 / 向空文件写入。
 */
async function handleCreateOrAppend(
  resolvedPath: string,
  inputPath: string,
  newString: string,
  readFileState: Map<string, ReadCacheEntry> | undefined,
) {
  // 检查文件是否存在
  let fileExists = false
  let existingContent = ''
  try {
    existingContent = await readFile(resolvedPath, 'utf-8')
    fileExists = true
  } catch (err) {
    if (!isEnoent(err)) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `读取文件失败: ${msg}`, isError: true }
    }
  }

  if (fileExists) {
    // 文件存在且有内容：拒绝
    if (existingContent.trim() !== '') {
      return {
        content: `编辑失败: 文件 ${inputPath} 已存在且有内容。无法通过空 old_string 覆盖。`,
        isError: true,
      }
    }
    // 文件存在但为空：写入
  } else {
    // 文件不存在：创建（确保目录存在）
    try {
      await mkdir(dirname(resolvedPath), { recursive: true })
    } catch {
      // 目录已存在，忽略
    }
  }

  // 写入内容
  try {
    await writeFile(resolvedPath, newString, 'utf-8')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: `写入文件失败: ${msg}`, isError: true }
  }

  // 更新 readFileState
  if (readFileState) {
    try {
      const newMtime = (await stat(resolvedPath)).mtimeMs
      readFileState.set(resolvedPath, {
        timestamp: Math.floor(newMtime),
        offset: undefined,
        limit: undefined,
        content: newString,
      })
    } catch {
      // stat 失败不影响结果
    }
  }

  return { content: fileExists ? `已编辑 ${inputPath}` : `已创建 ${inputPath}` }
}

/** 构建文件不存在的错误消息，带 fuzzy 建议 */
async function buildNotFoundMessage(resolvedPath: string, inputPath: string) {
  let message = `文件不存在: ${inputPath}`
  const similar = await findSimilarFile(resolvedPath)
  if (similar) {
    message += `\n你是否指的是: ${similar}`
  }
  return { content: message, isError: true as const }
}
