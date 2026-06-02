import type { ToolDefinition } from '@mech-code/shared'
import type { AgentMessage, AgentState } from '../agent/types.js'
import type { LLMProvider, ChatResponse, StreamResult } from '../provider/types.js'
import type { Tool, ToolOutput } from '../tools/types.js'

export type Awaitable<T> = T | Promise<T>

/** 模型调用函数类型 —— Wrap 链的节点签名 */
export type ModelCallFn = (ctx: RunContext) => Promise<StreamResult>

/** 工具调用函数类型 —— Wrap 链的节点签名 */
export type ToolCallFn = (ctx: ToolCallContext) => Promise<ToolOutput>

/** Props 字段描述符（文档化 + 开发模式校验） */
export interface PropDescriptor {
  /** 字段描述 */
  description: string
  /** 是否必填（缺失时开发模式下 console.warn） */
  required?: boolean
  /** 默认值（缺失时使用） */
  defaultValue?: unknown
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
   * 公有状态（可选）。
   * 声明在此的数据会自动同步到 AgentState.middlewareStates[name] 中，
   * 其他中间件可通过 ctx.state.middlewareStates 读取，支持序列化持久化。
   */
  state?: Record<string, unknown>

  /**
   * 声明中间件期望的 props（文档化 + 开发模式 warning）。
   * 框架不做强制校验，但在开发模式下会对 required 字段缺失发出警告。
   */
  propsSchema?: Record<string, PropDescriptor>

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
  tools?: Tool[]
  propsSchema?: Record<string, PropDescriptor>
}

// === 工厂函数 ===

/** createMiddleware 的初始化参数 */
export type MiddlewareInit = Omit<AgentMiddleware, 'state'> & {
  /** 初始状态（会被深克隆，确保多次调用返回独立实例） */
  state?: Record<string, unknown>
}

/**
 * createMiddleware —— 中间件工厂函数。
 *
 * 相比对象字面量：对 state 做深克隆保护，避免多实例共享状态。
 * 相比继承 Middleware 基类：无需 class + constructor，适合简单场景。
 *
 * @example
 * const logger = createMiddleware({
 *   name: 'logger',
 *   beforeModel(ctx) { console.log('turn', ctx.turnIndex) },
 * })
 *
 * @example
 * // 带状态 + 工具的自包含中间件
 * const counter = createMiddleware({
 *   name: 'call-counter',
 *   state: { count: 0 },
 *   tools: [checkCountTool],
 *   wrapToolCall(next, ctx) {
 *     this.state!.count = (this.state!.count as number) + 1
 *     return next(ctx)
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

  // === 调用方只读属性（不持久化，语义同 React props）===
  /** 调用方传入的只读配置/意图，中间件通过此字段读取运行时参数 */
  readonly props: Readonly<Record<string, unknown>>

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
