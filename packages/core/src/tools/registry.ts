import type { ToolDefinition } from '@mech-code/shared'
import type { Tool } from './types.js'

const registry = new Map<string, Tool>()

export function registerTool(tool: Tool): void {
  registry.set(tool.name, tool)
}

export function getTool(name: string): Tool | undefined {
  return registry.get(name)
}

export function getAllTools(): Tool[] {
  return Array.from(registry.values())
}

/**
 * 获取所有已注册工具的 LLM 精简定义，用于构建 ChatParams.tools。
 */
export function getToolDefinitions(): ToolDefinition[] {
  return Array.from(registry.values()).map((t) => t.toDefinition())
}

export function clearTools(): void {
  registry.clear()
}
