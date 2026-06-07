import type { SessionCheckpoint, Usage } from '@mech-code/shared'
import {
  deserializeAgentMessage,
  serializeAgentMessage,
  type AgentMessage,
} from '../message/message.js'

export type { AgentMessage } from '../message/message.js'

/**
 * Agent 的会话状态，由调用方持有并传入 run()。
 * Agent 在执行过程中直接修改此对象，调用方无需手动同步结果。
 */
export interface AgentState {
  /** 完整消息历史（只增不减；中间件可通过 message.metadata 维护自身标记） */
  messages: AgentMessage[]
  /** 累计 token 用量（跨多次 run() 累加） */
  usage: Usage
  /** 中间件/工具直接扩展的会话级动态状态 */
  [key: string]: unknown
}

/** 创建一个空的 AgentState，方便业务层初始化 */
export function createAgentState(): AgentState {
  return {
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
  }
}

/** 将 AgentState 序列化为可 JSON 化的形式 */
export function serializeAgentState(state: AgentState): SessionCheckpoint['state'] {
  return {
    ...structuredClone(state),
    messages: state.messages.map((message) => serializeAgentMessage(message)),
  }
}

/** 将序列化的 state 还原为 AgentState */
export function deserializeAgentState(serialized: SessionCheckpoint['state']): AgentState {
  const cloned = structuredClone(serialized)
  return {
    ...cloned,
    messages: cloned.messages.map((message) => deserializeAgentMessage(message)),
  }
}
