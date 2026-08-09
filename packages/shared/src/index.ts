// === 消息类型 ===

export type ImageSource =
  | { type: 'base64'; mediaType: string; data: string }
  | { type: 'url'; url: string }

/** 用户消息内容块 —— 支持多模态输入 */
export type UserContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: ImageSource }
  | { type: 'file'; data: Uint8Array; mediaType: string }

/** 助手消息内容块 —— 包含思考、文本与工具调用指令 */
export type AssistantContentBlock =
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

/** 可序列化的规范消息类型。user/assistant content 始终使用内容块数组。 */
export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: UserContentBlock[] }
  | { role: 'assistant'; content: AssistantContentBlock[] }
  | {
      role: 'tool'
      toolCallId: string
      toolName?: string
      content: string
      image?: ImageSource
    }

// === Provider 配置 ===
// ProviderConfig 已移至 @mech-code/core 的 provider/types.ts，在那里可引用完整的 ModelParams 类型。

// === 用量统计 ===

export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** 可安全序列化为 JSON 的值。 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

// === 工具类型 ===

/**
 * ToolDefinition — 发送给 LLM 的工具精简视图。
 * 仅包含 LLM 所需的最小字段，由 Provider 序列化为请求体。
 * 完整工具协议定义在 @mech-code/core 的 Tool 接口中。
 */
export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

// === 事件类型 ===

// === HITL 类型 ===

/** 暂停时未完成的工具调用 */
export interface PendingToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

/** AgentState 的可序列化形式，用于 checkpoint 的持久化与恢复。 */
export interface SerializableAgentState {
  messages: (Message & {
    metadata?: Record<string, unknown>
  })[]
  usage: Usage
  [key: string]: unknown
}

/** checkpoint 中保存的可恢复运行状态。 */
export interface SerializableRuntimeState {
  /** 当前执行链开始时间。resume 后继续沿用，用于统计完整执行耗时。 */
  startedAt: number
  /** 暂停时的轮次索引。 */
  turnIndex: number
  /** 暂停时尚未完成的工具调用。 */
  pendingToolCalls: PendingToolCall[]
}

/**
 * 暂停时 Loop 生成的快照，包含恢复执行所需的全部信息。
 * 可序列化为 JSON 持久化，恢复时从数据重建。
 */
export interface SessionCheckpoint {
  /** 暂停时的完整会话状态（含已执行工具的结果） */
  state: SerializableAgentState
  /** 恢复执行所需的可序列化 runtime 投影。 */
  runtime: SerializableRuntimeState
  /** 暂停原因 */
  reason: string
  /** 附带的业务数据 */
  payload?: Record<string, unknown>
  /** 时间戳 */
  suspendedAt: number
}

export type AgentEvent =
  | AgentRunStartEvent
  | AgentRunEndEvent
  | ReasoningStartEvent
  | ReasoningContentEvent
  | ReasoningEndEvent
  | TextStartEvent
  | TextDeltaEvent
  | TextEndEvent
  | ToolStartEvent
  | ToolInputDeltaEvent
  | ToolExecutingEvent
  | ToolResultEvent
  | ToolEndEvent
  | MCPStartEvent
  | MCPExecutingEvent
  | MCPResultEvent
  | MCPEndEvent
  | CustomAgentEvent
  | TurnStartEvent
  | TurnEndEvent
  | SuspendedEvent

export interface AgentRunStartEvent {
  type: 'agent_run_start'
  runId: string
  messages: Message[]
}

export interface AgentRunEndEvent {
  type: 'agent_run_end'
  runId: string
  usage: Usage
  messages: Message[]
  /** run 结束时的完整可序列化业务状态。 */
  state: SerializableAgentState
  stopReason: 'end_turn' | 'max_turns' | 'error' | 'abort' | 'suspended'
}

export interface ReasoningStartEvent {
  type: 'reasoning_start'
}

export interface ReasoningContentEvent {
  type: 'reasoning_content'
  text: string
}

export interface ReasoningEndEvent {
  type: 'reasoning_end'
  fullText: string
}

export interface TextStartEvent {
  type: 'text_start'
}

export interface TextDeltaEvent {
  type: 'text_delta'
  delta: string
}

export interface TextEndEvent {
  type: 'text_end'
  fullText: string
}

export interface ToolStartEvent {
  type: 'tool_start'
  toolCallId: string
  toolName: string
}

export interface ToolInputDeltaEvent {
  type: 'tool_input_delta'
  toolCallId: string
  delta: string
}

export interface ToolExecutingEvent {
  type: 'tool_executing'
  toolCallId: string
  toolName: string
  input: unknown
}

export interface ToolResultEvent {
  type: 'tool_result'
  toolCallId: string
  toolName: string
  output: unknown
  isError: boolean
}

export interface ToolEndEvent {
  type: 'tool_end'
  toolCallId: string
}

export interface MCPStartEvent {
  type: 'mcp_start'
  server: string
  method: string
}

export interface MCPExecutingEvent {
  type: 'mcp_executing'
  server: string
  method: string
  params: unknown
}

export interface MCPResultEvent {
  type: 'mcp_result'
  server: string
  method: string
  result: unknown
  isError: boolean
}

export interface MCPEndEvent {
  type: 'mcp_end'
  server: string
}

export interface CustomAgentEvent<TPayload extends JsonValue = JsonValue> {
  type: 'custom'
  runId: string
  turnIndex: number
  source: string
  name: string
  payload: TPayload
}

export interface TurnStartEvent {
  type: 'turn_start'
  turnIndex: number
}

export interface TurnEndEvent {
  type: 'turn_end'
  turnIndex: number
  usage: Usage
}

export interface SuspendedEvent {
  type: 'suspended'
  checkpoint: SessionCheckpoint
  reason: string
  payload?: Record<string, unknown>
}

// === 工具函数 ===

export { expandPath } from './path.js'
export { levenshtein } from './string.js'
