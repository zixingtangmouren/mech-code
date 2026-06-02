import { writeFile, stat, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { z } from 'zod'
import { expandPath } from '@mech-code/shared'
import { defineTool } from '@mech-code/core'
import type { ReadCacheEntry } from '@mech-code/core'

// === 常量 ===

/** 覆写已有文件时的最大允许大小（10 MB） */
const MAX_WRITE_FILE_SIZE = 10 * 1024 * 1024

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

/** 判断错误是否为 ENOENT */
function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
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

// === 工具定义 ===

/**
 * write_file —— 将内容写入文件，自动创建父目录。
 *
 * Phase 1 能力（安全基础）：
 * - 路径 ~ 展开 + 规范化
 * - 危险设备路径拦截
 * - validateInput 实现
 *
 * Phase 2 能力（读写一致性）：
 * - 覆写已有文件时的读前置校验（must read before overwrite）
 * - 文件修改时间戳校验
 * - 覆写大文件预检（10 MB 限制）
 * - 写入后更新 readFileState
 */
export const writeFileTool = defineTool({
  name: 'write_file',
  description:
    'Write content to a file. Creates the file if it does not exist, or overwrites it if it does. Parent directories are created automatically. Prefer edit_file for modifying existing files.',
  schema: z.object({
    path: z.string().min(1).describe('File path (relative to cwd or absolute, supports ~)'),
    content: z.string().describe('The full content to write to the file'),
  }),
  flags: { readonly: false, parallelSafe: false },

  getPrompt(ctx) {
    const hasEditTool = ctx.availableTools.includes('edit_file')
    const editHint = hasEditTool
      ? '\n- 修改现有文件时优先使用 edit_file 工具（仅发送 diff），write_file 仅用于创建新文件或完全重写'
      : ''

    return `将内容写入文件，如果文件已存在则覆写，不存在则创建（自动创建父目录）。

使用说明：
- path 参数支持绝对路径或相对于工作目录（${ctx.cwd}）的相对路径，也支持 ~ 表示主目录
- 如果目标文件已存在，必须先使用 read_file 读取后才能覆写${editHint}
- content 为完整的文件内容，会直接覆盖目标文件的全部内容
- 不要创建文档文件（*.md）或 README，除非用户明确要求`
  },

  validateInput(input) {
    // 危险设备路径拦截
    const rawPath = expandPath(input.path)
    if (BLOCKED_DEVICE_PATHS.has(rawPath)) {
      return { valid: false, error: `无法写入设备文件 ${input.path}。` }
    }
    return { valid: true }
  },

  async execute(input, ctx) {
    // 路径解析：展开 ~，然后相对 cwd 解析
    const resolvedPath = resolve(ctx.cwd, expandPath(input.path))
    const readFileState = getReadFileState(ctx.store)

    // === 文件存在性检查 ===
    let fileExists = false
    let existingSize = 0
    let existingMtimeMs = 0
    try {
      const stats = await stat(resolvedPath)
      fileExists = true
      existingSize = stats.size
      existingMtimeMs = stats.mtimeMs
    } catch (err) {
      if (!isEnoent(err)) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: `无法访问目标路径: ${msg}`, isError: true }
      }
    }

    if (fileExists) {
      // === 读前置校验（仅覆写时） ===
      if (!readFileState[resolvedPath]) {
        return {
          content:
            '文件已存在但尚未被读取。请先使用 read_file 读取文件内容，或使用 edit_file 进行局部修改。',
          isError: true,
        }
      }

      // === 时间戳校验 ===
      const cached = readFileState[resolvedPath]
      if (cached && Math.floor(existingMtimeMs) > cached.timestamp) {
        return {
          content:
            '文件自上次读取后已被外部修改（可能是用户编辑或 linter/formatter）。请重新读取后再写入。',
          isError: true,
        }
      }

      // === 大文件覆写预检 ===
      if (existingSize > MAX_WRITE_FILE_SIZE) {
        return {
          content: `目标文件过大 (${formatSize(existingSize)})，超出覆写限制 (${formatSize(MAX_WRITE_FILE_SIZE)})。`,
          isError: true,
        }
      }
    }

    // === 创建父目录 ===
    try {
      await mkdir(dirname(resolvedPath), { recursive: true })
    } catch {
      // 目录已存在，忽略
    }

    // === 写入文件 ===
    try {
      await writeFile(resolvedPath, input.content, 'utf-8')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `写入文件失败: ${msg}`, isError: true }
    }

    // === 更新 readFileState ===
    try {
      const newMtime = (await stat(resolvedPath)).mtimeMs
      readFileState[resolvedPath] = {
        timestamp: Math.floor(newMtime),
        offset: undefined,
        limit: undefined,
        content: input.content,
      }
    } catch {
      // stat 失败不影响写入结果
    }

    // === 返回结果 ===
    const lines = input.content.split('\n').length
    const bytes = Buffer.byteLength(input.content, 'utf-8')
    const type = fileExists ? '已覆写' : '已创建'

    return {
      content: `${type} ${input.path}（${lines} 行，${formatSize(bytes)}）`,
      metadata: {
        type: fileExists ? 'update' : 'create',
        filePath: resolvedPath,
        linesWritten: lines,
        bytesWritten: bytes,
      },
    }
  },
})
