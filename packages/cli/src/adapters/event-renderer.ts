import type { AgentEvent } from '@mech/shared'

/**
 * 将核心 AgentEvent 适配为终端 UI 的渲染操作。
 */
export function renderEvent(event: AgentEvent): string | null {
  switch (event.type) {
    case 'text_delta':
      return event.delta
    case 'reasoning_content':
      return `[thinking] ${event.text}`
    case 'tool_executing':
      return `[tool] ${event.toolName}`
    case 'tool_result':
      return event.isError ? `[error] ${String(event.output)}` : null
    default:
      return null
  }
}
