import type { Tool } from '../types.js'
import { readFileTool } from './read-file.js'
import { writeFileTool } from './write-file.js'
import { listDirTool } from './list-dir.js'
import { editFileTool } from './edit-file.js'
import { bashTool } from './bash/index.js'

export { readFileTool, writeFileTool, listDirTool, editFileTool, bashTool }

/**
 * 获取所有内置工具实例列表。
 */
export function getBuiltinTools(): Tool[] {
  return [readFileTool, writeFileTool, listDirTool, editFileTool, bashTool]
}
