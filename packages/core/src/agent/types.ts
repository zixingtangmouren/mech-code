import type { Message, Usage, SessionCheckpoint } from '@mech/shared'

/**
 * 带框架内部标记的消息类型。
 * 扩展了 _compressed 标记，供摘要中间件使用，不对外暴露语义。
 */
export type AgentMessage = Message & {
  /** 被摘要压缩过的消息，发送给 LLM 前应过滤（由中间件维护，Loop 不感知） */
  _compressed?: true
}

/**
 * Agent 的会话状态，由调用方持有并传入 run()。
 * Agent 在执行过程中直接修改此对象，调用方无需手动同步结果。
 */
export interface AgentState {
  /** 完整消息历史（只增不减，压缩时仅打 _compressed 标记） */
  messages: AgentMessage[]
  /** 累计 token 用量（跨多次 run() 累加） */
  usage: Usage
  /** 中间件/工具自由读写的键值对 */
  metadata: Map<string, unknown>
  /** 各中间件的公有状态（按中间件 name 索引，支持序列化持久化） */
  middlewareStates: Record<string, Record<string, unknown>>
}

/** 创建一个空的 AgentState，方便业务层初始化 */
export function createAgentState(): AgentState {
  return {
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    metadata: new Map(),
    middlewareStates: {},
  }
}

export interface RunParams {
  /** 会话状态（由调用方持有，run() 直接修改此对象） */
  state: AgentState
  /** 最大循环轮数，覆盖 AgentConfig.maxTurns */
  maxTurns?: number
  signal?: AbortSignal
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
