import { writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { z } from 'zod'
import { defineTool } from '../define.js'

/**
 * write_file —— 将内容写入文件，自动创建父目录。
 */
export const writeFileTool = defineTool({
  name: 'write_file',
  description:
    'Write content to a file. Creates the file if it does not exist. Overwrites existing content. Parent directories are created automatically.',
  schema: z.object({
    path: z.string().min(1).describe('File path (relative to cwd or absolute)'),
    content: z.string().describe('The content to write to the file'),
  }),
  flags: { readonly: false, parallelSafe: false },

  async execute(input, ctx) {
    const filePath = resolve(ctx.cwd, input.path)
    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, input.content, 'utf-8')
      return { content: `已写入 ${filePath}（${input.content.length} 字符）` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `写入文件失败: ${msg}`, isError: true }
    }
  },
})
