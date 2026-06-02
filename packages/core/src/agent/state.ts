import type { Message, SessionCheckpoint, Usage } from '@mech-code/shared'

/**
 * 带框架内部标记的消息类型。
 * 扩展了 _compressed 标记，供摘要中间件使用，不对外暴露语义。
 */
export type AgentMessage = Message & {
  /** 被摘要压缩过的消息，发送给 LLM 前应过滤（由中间件维护，Loop 不感知） */
  _compressed?: true
  /** 工具返回的图片数据（仅 role='tool' 时有值），供 Provider serializer 生成多模态 content block */
  _imageData?: { base64: string; mediaType: string }
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
  /** 中间件/工具共享读写的持久化状态 */
  store: Record<string, unknown>
}

/** 创建一个空的 AgentState，方便业务层初始化 */
export function createAgentState(): AgentState {
  return {
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    store: {},
  }
}

/** 将 AgentState 序列化为可 JSON 化的形式 */
export function serializeAgentState(state: AgentState): SessionCheckpoint['state'] {
  return {
    messages: structuredClone(state.messages),
    usage: { ...state.usage },
    store: structuredClone(state.store),
  }
}

/** 将序列化的 state 还原为 AgentState */
export function deserializeAgentState(serialized: SessionCheckpoint['state']): AgentState {
  return {
    messages: serialized.messages,
    usage: serialized.usage,
    store: structuredClone(serialized.store),
  }
}
