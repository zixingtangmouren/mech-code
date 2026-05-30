import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { defineTool } from '../define.js'

/**
 * edit_file —— 通过精确字符串匹配进行文件编辑。
 * oldText 必须在文件中恰好出现一次，将被替换为 newText。
 */
export const editFileTool = defineTool({
  name: 'edit_file',
  description:
    'Edit a file by replacing an exact string match. The oldText must appear exactly once in the file. Use this for surgical edits instead of rewriting the entire file.',
  schema: z.object({
    path: z.string().min(1).describe('File path (relative to cwd or absolute)'),
    oldText: z.string().min(1).describe('The exact text to find (must appear exactly once)'),
    newText: z.string().describe('The replacement text'),
  }),
  flags: { readonly: false, parallelSafe: false },

  async execute(input, ctx) {
    const filePath = resolve(ctx.cwd, input.path)

    let content: string
    try {
      content = await readFile(filePath, 'utf-8')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `读取文件失败: ${msg}`, isError: true }
    }

    // 检查匹配次数
    const occurrences = countOccurrences(content, input.oldText)
    if (occurrences === 0) {
      return {
        content: `编辑失败: 在 ${input.path} 中未找到指定的 oldText。请检查文本是否完全匹配（包括空格和换行）。`,
        isError: true,
      }
    }
    if (occurrences > 1) {
      return {
        content: `编辑失败: oldText 在 ${input.path} 中匹配了 ${occurrences} 次，必须恰好匹配 1 次。请提供更多上下文以确保唯一匹配。`,
        isError: true,
      }
    }

    // 执行替换
    const newContent = content.replace(input.oldText, input.newText)
    try {
      await writeFile(filePath, newContent, 'utf-8')
      return { content: `已编辑 ${input.path}` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `写入文件失败: ${msg}`, isError: true }
    }
  },
})

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
