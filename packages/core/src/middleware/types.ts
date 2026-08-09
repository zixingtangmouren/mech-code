import type { JsonValue, PendingToolCall, ToolDefinition } from '@mech-code/shared'
import type { AgentState } from '../agent/state.js'
import type {
  LLMProvider,
  ChatResponse,
  StreamResult,
  ChatParams,
  CallOptions,
} from '../provider/types.js'
import type { Tool, ToolOutput } from '../tools/types.js'

export type Awaitable<T> = T | Promise<T>

/** 模型调用 handler —— Wrap 链继续向内执行的节点签名 */
export type ModelCallHandler = (request: ModelCallRequest) => Promise<StreamResult>

/** 工具调用 handler —— Wrap 链继续向内执行的节点签名 */
export type ToolCallHandler = (request: ToolCallRequest) => Promise<ToolOutput>

export type AgentStopReason = 'end_turn' | 'max_turns' | 'error' | 'abort' | 'suspended'

export interface CustomAgentEventInput {
  source: string
  name: string
  payload: JsonValue
}

export interface AgentRuntime {
  readonly runId: string
  /** 当前执行链开始时间；从 checkpoint 恢复时保持不变。 */
  readonly startedAt: number
  /** 调用方为本次运行传入的只读环境信息。 */
  readonly props: Readonly<Record<string, unknown>>
  readonly provider: LLMProvider
  readonly system: string
  readonly tools: readonly ToolDefinition[]
  readonly middleware: readonly AgentMiddleware[]
  readonly signal: AbortSignal
  /** 当前模型调用轮次。 */
  readonly turnIndex: number
  /** 当前 run 的结束原因。 */
  readonly stopReason: AgentStopReason
  /** 最近一次模型响应的只读快照。 */
  readonly lastResponse?: Readonly<ChatResponse>
  /** 尚未完成的工具调用只读快照。 */
  readonly pendingToolCalls: readonly Readonly<PendingToolCall>[]
  /** 向 Agent 事件流发送中间件自定义的可序列化事件。 */
  readonly emitCustomAgentEvent: (event: CustomAgentEventInput) => void
}

export interface AgentMiddleware {
  name: string

  /**
   * 中间件声明的工具列表（可选）。
   * 声明在此的工具会自动合并到 Agent 可用工具集中，
   * 使中间件成为自包含的能力单元（工具 + 状态 + 拦截 = 一体化）。
   * 工具名称冲突时框架抛出错误，确保唯一性。
   */
  tools?: Tool[]

  /**
   * 默认 AgentState 扩展字段（可选）。
   * 声明在此的数据会合并到 AgentState 顶层，不覆盖调用方已有字段。
   */
  state?: Record<string, unknown>

  // === Hook 式：状态观察与修改 ===

  /** Agent run 开始时触发，可做初始化工作（加载配置、初始化计数器等） */
  beforeAgent?(ctx: RunContext): Awaitable<void>
  /** Agent run 结束后触发（类似 finally，即使出错也执行），用于清理和收尾 */
  afterAgent?(ctx: RunContext): Awaitable<void>

  /** 模型调用前：可直接修改 state.messages 或维护生命周期状态 */
  beforeModel?(ctx: RunContext): Awaitable<void>
  /** 模型响应后、工具执行前：可观察模型输出、更新 state 中的统计或元信息 */
  afterModel?(ctx: RunContext): Awaitable<void>

  // === Wrap 式：包裹核心操作 ===

  /**
   * 包裹模型调用。
   * 调用 handler(request) 执行内层请求，可改写本次真实 provider 入参、重试、缓存或兜底。
   */
  wrapModelCall?(request: ModelCallRequest, handler: ModelCallHandler): Awaitable<StreamResult>

  /**
   * 包裹工具调用。
   * 调用 handler(request) 执行内层工具，可改写本次真实工具入参、拒绝、重试或截断结果。
   */
  wrapToolCall?(request: ToolCallRequest, handler: ToolCallHandler): Awaitable<ToolOutput>
}

/**
 * 有状态中间件的基类。
 * 继承此类可通过 state 字段声明默认 AgentState 扩展字段。
 * 无状态的简单中间件可直接使用 AgentMiddleware 接口（对象字面量形式）。
 */
export abstract class Middleware implements AgentMiddleware {
  abstract name: string
  state: Record<string, unknown> = {}
  tools?: Tool[]
}

// === 工厂函数 ===

/** createMiddleware 的初始化参数 */
export type MiddlewareInit = Omit<AgentMiddleware, 'state'> & {
  /** 默认 AgentState 扩展字段（会被深克隆，确保多次调用返回独立实例） */
  state?: Record<string, unknown>
}

/**
 * createMiddleware —— 中间件工厂函数。
 *
 * 相比对象字面量：对 state 做深克隆保护，避免多实例共享默认状态。
 * 相比继承 Middleware 基类：无需 class + constructor，适合简单场景。
 *
 * @example
 * const logger = createMiddleware({
 *   name: 'logger',
 *   beforeModel(ctx) { console.log('turn', ctx.runtime.turnIndex) },
 * })
 *
 * @example
 * // 带状态 + 工具的自包含中间件
 * const counter = createMiddleware({
 *   name: 'call-counter',
 *   state: { count: 0 },
 *   tools: [checkCountTool],
 *   wrapToolCall(request, handler) {
 *     request.context.state.count = (request.context.state.count as number) + 1
 *     return handler(request)
 *   },
 * })
 */
export function createMiddleware(init: MiddlewareInit): AgentMiddleware {
  const { state: rawState, ...rest } = init
  return {
    ...rest,
    state: rawState ? structuredClone(rawState) : undefined,
  }
}

/** 中间件在每轮中可访问的 Context */
export interface RunContext {
  /** 完整会话状态（可变引用，中间件对 state 的修改会持久化） */
  state: AgentState
  /** 本次执行的只读框架状态、环境信息与运行能力。 */
  readonly runtime: AgentRuntime
}

/** 模型调用 Wrap 的本次真实请求对象 */
export interface ModelCallRequest {
  /** 当前 run/turn 的共享上下文 */
  readonly context: RunContext
  /** 本次调用使用的 provider，wrapper 可替换为 fallback provider */
  provider: LLMProvider
  /** 本次真实传入 provider 的聊天参数 */
  params: ChatParams
  /** 本次真实传入 provider 的调用选项 */
  options: CallOptions
}

/** 工具调用 Wrap 的本次真实请求对象 */
export interface ToolCallRequest {
  /** 当前 run/turn 的共享上下文 */
  readonly context: RunContext
  readonly toolCallId: string
  readonly toolName: string
  /** 本次真实传入工具实现的输入 */
  readonly toolInput: Record<string, unknown>
  /** 可选动态工具实例；缺省时由核心 toolMap 按 toolName 查找 */
  readonly tool?: Tool
}

/** 工具调用阶段的 Context，扩展了工具调用的相关字段 */
export interface ToolCallContext extends RunContext {
  readonly toolCallId: string
  readonly toolName: string
  readonly toolInput: Record<string, unknown>
}
