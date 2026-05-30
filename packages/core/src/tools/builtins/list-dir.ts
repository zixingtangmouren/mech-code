import { readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { z } from 'zod'
import { defineTool } from '../define.js'

/**
 * list_dir —— 列出目录内容，支持递归展示。
 */
export const listDirTool = defineTool({
  name: 'list_dir',
  description:
    'List the contents of a directory. Returns file and directory names. Use recursive mode to show a tree structure (limited depth).',
  schema: z.object({
    path: z.string().min(1).describe('Directory path (relative to cwd or absolute)'),
    recursive: z
      .boolean()
      .optional()
      .default(false)
      .describe('Whether to list recursively (max depth 3)'),
  }),
  flags: { readonly: true, parallelSafe: true },

  async execute(input, ctx) {
    const dirPath = resolve(ctx.cwd, input.path)
    try {
      if (input.recursive) {
        const lines: string[] = []
        await walkDir(dirPath, dirPath, '', lines, 0, 3)
        return { content: lines.join('\n') || '(空目录)' }
      }

      const entries = await readdir(dirPath, { withFileTypes: true })
      const lines = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      return { content: lines.join('\n') || '(空目录)' }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `列出目录失败: ${msg}`, isError: true }
    }
  },
})

/** 递归遍历目录，生成缩进树结构 */
async function walkDir(
  basePath: string,
  currentPath: string,
  prefix: string,
  lines: string[],
  depth: number,
  maxDepth: number,
): Promise<void> {
  if (depth >= maxDepth) return

  const entries = await readdir(currentPath, { withFileTypes: true })
  // 排序：目录在前，文件在后
  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1
    if (!a.isDirectory() && b.isDirectory()) return 1
    return a.name.localeCompare(b.name)
  })

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    const isLast = i === entries.length - 1
    const connector = isLast ? '└── ' : '├── '
    const childPrefix = isLast ? '    ' : '│   '

    if (entry.isDirectory()) {
      lines.push(`${prefix}${connector}${entry.name}/`)
      await walkDir(
        basePath,
        join(currentPath, entry.name),
        prefix + childPrefix,
        lines,
        depth + 1,
        maxDepth,
      )
    } else {
      lines.push(`${prefix}${connector}${entry.name}`)
    }
  }
}
