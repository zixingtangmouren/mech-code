import type { AgentEvent, AssistantContentBlock, ToolDefinition, Usage } from '@mech-code/shared'
import type { InternalMessage } from '../message/types.js'

// === 模型生成参数 ===

export interface ModelParams {
  temperature?: number
  maxTokens?: number
  topP?: number
  stopSequences?: string[]
  /** 厂商特定参数逃生口（如 Anthropic 的 thinking、OpenAI 的 response_format） */
  extra?: Record<string, unknown>
}

// === Provider 配置 ===

export interface ProviderConfig {
  apiKey: string
  model: string
  baseUrl?: string
  headers?: Record<string, string>
  /** 所有调用的默认生成参数，可被 CallOptions.modelParams 覆盖 */
  defaultParams?: ModelParams
}

// === 聊天参数（Provider 输入）===

export interface ChatParams {
  messages: InternalMessage[]
  system?: string
  tools?: ToolDefinition[]
}

// === 聊天响应（非流式，Provider 输出）===

export interface ChatResponse {
  content: AssistantContentBlock[]
  usage: Usage
  stopReason: string
}

// === 单次调用选项 ===

export interface CallOptions {
  signal?: AbortSignal
  /** 仅本次调用生效的参数覆盖（浅合并 ProviderConfig.defaultParams） */
  modelParams?: ModelParams
}

// === 流式结果双通道 ===

/**
 * StreamResult — Provider.stream() 的返回值。
 *
 * - stream: 逐事件消费（UI 渲染用）
 * - final:  流结束后 resolve 的完整响应（Agent Loop 用）
 * - abort:  主动中止流
 */
export interface StreamResult {
  stream: AsyncIterable<AgentEvent>
  final: Promise<ChatResponse>
  abort(): void
}

// === LLM Provider 接口 ===

export interface LLMProvider {
  readonly name: string
  chat(params: ChatParams, options?: CallOptions): Promise<ChatResponse>
  stream(params: ChatParams, options?: CallOptions): StreamResult
}

// === 流数据元信息 ===

export interface StreamMeta {
  usage: Usage
  stopReason: string
}

// === 流归一化器（Provider 内部使用）===

/**
 * StreamNormalizer — 将厂商原始 chunk 转换为 AgentEvent 的有状态适配器。
 * 每个 Provider 实现各自的 Normalizer（有状态、推送式）。
 */
export interface StreamNormalizer<TVendorChunk = unknown> {
  /** 处理一个厂商 chunk，返回零或多个 AgentEvent */
  push(chunk: TVendorChunk): AgentEvent[]
  /** 流结束时刷出所有缓冲状态 */
  flush(): AgentEvent[]
  /** 流结束后获取 usage 和 stopReason */
  getStreamMeta(): StreamMeta
}

// === 序列化选项 ===

export interface SerializeOptions {
  system?: string
  tools?: ToolDefinition[]
  modelParams?: ModelParams
}

// === 消息序列化器（Provider 内部使用）===

/**
 * MessageSerializer — 将 InternalMessage[] 转换为厂商 API 请求体格式。
 */
export interface MessageSerializer<TVendorRequest = unknown> {
  serialize(messages: InternalMessage[], options: SerializeOptions): TVendorRequest
}
