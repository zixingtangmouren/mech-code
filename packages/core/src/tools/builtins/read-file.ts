import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { defineTool } from '../define.js'

/**
 * read_file —— 读取文件内容，支持指定行范围。
 */
export const readFileTool = defineTool({
  name: 'read_file',
  description:
    'Read the contents of a file. You can optionally specify a line range to read a subset of lines.',
  schema: z.object({
    path: z.string().min(1).describe('File path (relative to cwd or absolute)'),
    startLine: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Start line number (1-based, inclusive)'),
    endLine: z.number().int().min(1).optional().describe('End line number (1-based, inclusive)'),
  }),
  flags: { readonly: true, parallelSafe: true },

  async execute(input, ctx) {
    const filePath = resolve(ctx.cwd, input.path)
    let content: string
    try {
      content = await readFile(filePath, 'utf-8')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `读取文件失败: ${msg}`, isError: true }
    }

    // 按行范围截取
    if (input.startLine || input.endLine) {
      const lines = content.split('\n')
      const start = (input.startLine ?? 1) - 1
      const end = input.endLine ?? lines.length
      const sliced = lines.slice(start, end)
      const header = `[${input.path}] lines ${start + 1}-${Math.min(end, lines.length)} of ${lines.length}\n`
      return { content: header + sliced.join('\n') }
    }

    return { content }
  },
})
