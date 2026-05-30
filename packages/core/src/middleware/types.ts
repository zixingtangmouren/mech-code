import type { Message, ToolDefinition, Usage } from '@mech/shared'
import type { ProviderConfig } from '../provider/types.js'
import type { ToolOutput } from '../tools/types.js'

export interface AgentMiddleware {
  name: string

  // 请求阶段
  beforeLLMCall?(ctx: MiddlewareContext): Promise<void> | void
  afterLLMResponse?(ctx: MiddlewareContext): Promise<void> | void

  // 工具阶段
  beforeToolExec?(ctx: ToolExecContext): Promise<void> | void
  afterToolExec?(ctx: ToolExecContext): Promise<void> | void

  // 生命周期
  onRunStart?(ctx: MiddlewareContext): Promise<void> | void
  onTurnEnd?(ctx: MiddlewareContext): Promise<void> | void
  onRunEnd?(ctx: MiddlewareContext): Promise<void> | void
}

export interface MiddlewareContext {
  // 可变属性
  messages: Message[]
  system: string
  tools: ToolDefinition[]
  metadata: Map<string, unknown>

  // 只读属性
  readonly turnIndex: number
  readonly usage: Usage
  readonly provider: ProviderConfig
  readonly signal: AbortSignal
}

export interface ToolExecContext extends MiddlewareContext {
  toolName: string
  toolInput: Record<string, unknown>
  /** afterToolExec 阶段可读取工具的实际输出 */
  toolResult?: ToolOutput
  /** 设为 true 则跳过工具执行（由权限中间件在 beforeToolExec 中设置） */
  skipExecution?: boolean
  /** 覆盖工具输出，跳过执行时作为替代结果返回 */
  overrideResult?: ToolOutput
}
