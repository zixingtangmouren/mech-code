// Agent 模块
export { Agent, createAgent } from './agent/agent.js'
export type { AgentConfig } from './agent/agent.js'
export type { RunParams, RunResult, AgentState, AgentMessage } from './agent/types.js'
export { createAgentState } from './agent/types.js'

// HITL（Human-in-the-Loop）暂停与恢复
export {
  SuspendSignal,
  isSuspendSignal,
  serializeAgentState,
  deserializeAgentState,
} from './agent/hitl.js'
export type { ResumeParams, ToolCallDecision } from './agent/hitl.js'

// Provider 模块
export type {
  LLMProvider,
  ChatParams,
  ChatResponse,
  CallOptions,
  StreamResult,
  StreamMeta,
  ModelParams,
  ProviderConfig,
  StreamNormalizer,
  MessageSerializer,
  SerializeOptions,
} from './provider/types.js'
export { ProviderError, httpStatusToCode } from './provider/errors.js'
export type { ProviderErrorCode } from './provider/errors.js'
export { AnthropicProvider } from './provider/anthropic/provider.js'
export { OpenAIProvider } from './provider/openai/provider.js'
export { OpenAICompatibleProvider } from './provider/openai-compatible/provider.js'

// 消息协议
export type { InternalMessage, UserContentBlock, AssistantContentBlock } from './message/types.js'
export {
  normalizeMessage,
  normalizeMessages,
  denormalizeMessage,
  denormalizeMessages,
} from './message/normalize.js'
export { MessageAccumulator } from './message/accumulator.js'
export { buildChatParams } from './message/builder.js'
export {
  estimateTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
} from './message/tokenizer.js'

// 中间件
export type {
  AgentMiddleware,
  RunContext,
  ToolCallContext,
  ModelCallFn,
  ToolCallFn,
  Awaitable,
} from './middleware/types.js'
export { Middleware } from './middleware/types.js'
export { MiddlewarePipeline } from './middleware/pipeline.js'

// 工具协议
export type {
  Tool,
  ToolFlags,
  ToolPromptContext,
  ToolRunContext,
  ToolOutput,
  ValidationResult,
  ReadCacheEntry,
} from './tools/types.js'
export { defineTool } from './tools/define.js'
export type { ToolInit, ToolZodInit } from './tools/define.js'
export {
  registerTool,
  getTool,
  getAllTools,
  getToolDefinitions,
  clearTools,
} from './tools/registry.js'
export {
  readFileTool,
  writeFileTool,
  listDirTool,
  editFileTool,
  bashTool,
  getBuiltinTools,
} from './tools/builtins/index.js'

// 重新导出供外部消费者使用的共享类型
export type {
  Message,
  UserContentBlock as UserContentBlockExternal,
  AssistantContentBlock as AssistantContentBlockExternal,
  ImageSource,
  Usage,
  ToolDefinition,
  AgentEvent,
} from '@mech-code/shared'
