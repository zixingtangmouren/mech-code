import type { ToolDefinition } from '@mech/shared'
import type { AgentMessage, AgentState } from '../agent/types.js'
import type { LLMProvider, ChatResponse, StreamResult } from '../provider/types.js'
import type { ToolOutput } from '../tools/types.js'

export type Awaitable<T> = T | Promise<T>

/** LLM 调用函数类型 —— Wrap 链的节点签名 */
export type LLMCallFn = (ctx: RunContext) => Promise<StreamResult>

/** 工具执行函数类型 —— Wrap 链的节点签名 */
export type ToolExecFn = (ctx: ToolExecContext) => Promise<ToolOutput>

export interface AgentMiddleware {
  name: string

  // === Hook 式（观察 + 修改 Context 数据）===

  /** run 开始时触发，可做初始化工作 */
  onRunStart?(ctx: RunContext): Awaitable<void>
  /** 每轮结束后触发，可记录统计、清理临时状态 */
  onTurnEnd?(ctx: RunContext): Awaitable<void>
  /** run 结束后触发（类似 finally，即使出错也执行） */
  onRunEnd?(ctx: RunContext): Awaitable<void>

  /** LLM 调用前：可修改 callMessages / system / tools（做上下文压缩、动态注入等） */
  beforeLLMCall?(ctx: RunContext): Awaitable<void>
  /** LLM 响应后、工具执行前：可修改/拦截工具调用决策 */
  afterLLMResponse?(ctx: RunContext): Awaitable<void>

  /** 工具执行前：可做参数校验、权限审批；设置 ctx.skipExecution 可跳过执行 */
  beforeToolExec?(ctx: ToolExecContext): Awaitable<void>
  /** 工具执行后：可截断过长结果、格式化输出 */
  afterToolExec?(ctx: ToolExecContext): Awaitable<void>

  // === Wrap 式（包裹核心操作，适合重试、缓存、限流）===

  /**
   * 包裹 LLM 调用。调用 next(ctx) 执行实际请求，可在外部添加重试/缓存逻辑。
   * beforeLLMCall hooks 在 wrap 链之前执行，重试时不会重复触发 hooks。
   */
  wrapLLMCall?(next: LLMCallFn, ctx: RunContext): Awaitable<StreamResult>

  /**
   * 包裹工具执行。调用 next(ctx) 执行实际工具，可在外部添加超时/熔断逻辑。
   */
  wrapToolExec?(next: ToolExecFn, ctx: ToolExecContext): Awaitable<ToolOutput>
}

/** 中间件在每轮中可访问的 Context —— 含完整状态和本次 LLM 调用的投影 */
export interface RunContext {
  // === 完整会话状态（可变引用，中间件对 state 的修改会持久化）===
  state: AgentState

  // === LLM 调用投影（每轮开始时从 state.messages 生成快照，中间件可改写）===
  /** 即将发给 LLM 的消息列表（修改此字段只影响本次调用，不修改历史） */
  callMessages: AgentMessage[]
  /** 即将发给 LLM 的 system prompt（中间件可追加摘要、工具描述等） */
  system: string
  /** 即将发给 LLM 的工具定义列表（中间件可动态增减） */
  tools: ToolDefinition[]

  // === LLM 响应（afterLLMResponse 阶段可读）===
  lastResponse?: ChatResponse

  // === 只读元信息 ===
  readonly turnIndex: number
  readonly provider: LLMProvider
  readonly signal: AbortSignal
}

/** 工具执行阶段的 Context，扩展了工具调用的相关字段 */
export interface ToolExecContext extends RunContext {
  readonly toolCallId: string
  readonly toolName: string
  readonly toolInput: Record<string, unknown>
  /** afterToolExec 阶段可读取工具的实际输出 */
  toolResult?: ToolOutput
  /** 设为 true 则跳过工具执行（由权限中间件在 beforeToolExec 中设置） */
  skipExecution?: boolean
  /** 覆盖工具输出，skipExecution 为 true 时作为替代结果返回 */
  overrideResult?: ToolOutput
}

/** 向后兼容别名 */
export type MiddlewareContext = RunContext
