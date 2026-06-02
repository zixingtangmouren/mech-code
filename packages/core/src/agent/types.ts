import type { SessionCheckpoint, Usage } from '@mech-code/shared'
import type { AgentState } from './state.js'
export type { AgentMessage, AgentState } from './state.js'

export interface RunParams {
  /** 会话状态（由调用方持有，run() 直接修改此对象） */
  state: AgentState
  /** 最大循环轮数，覆盖 AgentConfig.maxTurns */
  maxTurns?: number
  signal?: AbortSignal
  /**
   * 调用方传入的只读属性（每次 run 临时有效，不持久化到 checkpoint）。
   * 用于向中间件传递运行时配置/意图（如 userId、requestId、featureFlags 等）。
   * 中间件通过 ctx.props 读取，不可修改。
   */
  props?: Readonly<Record<string, unknown>>
}

export interface RunResult {
  /** 最后一轮 assistant 的文本输出 */
  text: string
  /** 终止原因 */
  stopReason: 'end_turn' | 'max_turns' | 'error' | 'abort' | 'suspended'
  /** 本次 run 的增量 token 用量（不含历史累计） */
  usage: Usage
  /** 本次 run 执行的轮次数 */
  turnsUsed: number
  /** 暂停时的 checkpoint（仅 stopReason === 'suspended' 时有值） */
  checkpoint?: SessionCheckpoint
}
