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

/**
 * 外部消息类型 —— SDK 面向用户的类型。
 * 支持使用 `string` 作为纯文本内容的简写。
 */
export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | UserContentBlock[] }
  | { role: 'assistant'; content: string | AssistantContentBlock[] }
  | { role: 'tool'; toolCallId: string; content: string }

// === Provider 配置 ===
// ProviderConfig 已移至 @mech/core 的 provider/types.ts，在那里可引用完整的 ModelParams 类型。

// === 用量统计 ===

export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

// === 工具类型 ===

/**
 * ToolDefinition — 发送给 LLM 的工具精简视图。
 * 仅包含 LLM 所需的最小字段，由 Provider 序列化为请求体。
 * 完整工具协议定义在 @mech/core 的 Tool 接口中。
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

/**
 * AgentState 的可序列化形式（metadata Map 转为普通对象）。
 * 用于 checkpoint 的持久化与恢复。
 */
export interface SerializableAgentState {
  messages: (Message & { _compressed?: true })[]
  usage: Usage
  /** metadata Map 序列化为 plain object */
  metadata: Record<string, unknown>
  middlewareStates: Record<string, Record<string, unknown>>
}

/**
 * 暂停时 Loop 生成的快照，包含恢复执行所需的全部信息。
 * 可序列化为 JSON 持久化，恢复时从数据重建。
 */
export interface SessionCheckpoint {
  /** 暂停时的完整会话状态（含已执行工具的结果） */
  state: SerializableAgentState
  /** 暂停时未完成的 tool calls（恢复时从这里继续执行） */
  pendingToolCalls: PendingToolCall[]
  /** 暂停原因 */
  reason: string
  /** 附带的业务数据 */
  payload?: Record<string, unknown>
  /** 暂停时的轮次索引 */
  turnIndex: number
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
