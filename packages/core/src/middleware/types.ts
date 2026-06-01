import type { ToolDefinition } from '@mech-code/shared'
import type { AgentMessage, AgentState } from '../agent/types.js'
import type { LLMProvider, ChatResponse, StreamResult } from '../provider/types.js'
import type { ToolOutput } from '../tools/types.js'

export type Awaitable<T> = T | Promise<T>

/** 模型调用函数类型 —— Wrap 链的节点签名 */
export type ModelCallFn = (ctx: RunContext) => Promise<StreamResult>

/** 工具调用函数类型 —— Wrap 链的节点签名 */
export type ToolCallFn = (ctx: ToolCallContext) => Promise<ToolOutput>

export interface AgentMiddleware {
  name: string

  /**
   * 公有状态（可选）。
   * 声明在此的数据会自动同步到 AgentState.middlewareStates[name] 中，
   * 其他中间件可通过 ctx.state.middlewareStates 读取，支持序列化持久化。
   */
  state?: Record<string, unknown>

  // === Hook 式：状态观察与修改 ===

  /** Agent run 开始时触发，可做初始化工作（加载配置、初始化计数器等） */
  beforeAgent?(ctx: RunContext): Awaitable<void>
  /** Agent run 结束后触发（类似 finally，即使出错也执行），用于清理和收尾 */
  afterAgent?(ctx: RunContext): Awaitable<void>

  /** 模型调用前：可修改 callMessages / system / tools（上下文压缩、动态注入等） */
  beforeModel?(ctx: RunContext): Awaitable<void>
  /** 模型响应后、工具执行前：可观察模型输出、更新 state 中的统计或元信息 */
  afterModel?(ctx: RunContext): Awaitable<void>

  // === Wrap 式：包裹核心操作 ===

  /** 包裹模型调用。调用 next(ctx) 执行实际请求，可在外部添加重试/缓存/限流逻辑 */
  wrapModelCall?(next: ModelCallFn, ctx: RunContext): Awaitable<StreamResult>

  /** 包裹工具调用。调用 next(ctx) 执行实际工具，可在外部添加权限/超时/熔断逻辑 */
  wrapToolCall?(next: ToolCallFn, ctx: ToolCallContext): Awaitable<ToolOutput>
}

/**
 * 有状态中间件的基类。
 * 继承此类可通过 state 字段声明公有状态，框架会自动同步到 AgentState.middlewareStates。
 * 无状态的简单中间件可直接使用 AgentMiddleware 接口（对象字面量形式）。
 */
export abstract class Middleware implements AgentMiddleware {
  abstract name: string
  state: Record<string, unknown> = {}
}

/** 中间件在每轮中可访问的 Context —— 含完整状态和本次模型调用的投影 */
export interface RunContext {
  // === 完整会话状态（可变引用，中间件对 state 的修改会持久化）===
  state: AgentState

  // === 模型调用投影（每轮开始时从 state.messages 生成快照，中间件可改写）===
  /** 即将发给模型的消息列表（修改此字段只影响本次调用，不修改历史） */
  callMessages: AgentMessage[]
  /** 即将发给模型的 system prompt（中间件可追加摘要、工具描述等） */
  system: string
  /** 即将发给模型的工具定义列表（中间件可动态增减） */
  tools: ToolDefinition[]

  // === 模型响应（afterModel 阶段可读）===
  lastResponse?: ChatResponse

  // === 只读元信息 ===
  readonly turnIndex: number
  readonly provider: LLMProvider
  readonly signal: AbortSignal
}

/** 工具调用阶段的 Context，扩展了工具调用的相关字段 */
export interface ToolCallContext extends RunContext {
  readonly toolCallId: string
  readonly toolName: string
  readonly toolInput: Record<string, unknown>
}
