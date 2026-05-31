import type { AgentEvent, AssistantContentBlock, SessionCheckpoint } from '@mech/shared'
import type { AgentState, RunParams, RunResult } from './types.js'
import type { RunContext, ToolCallContext, ModelCallFn, ToolCallFn } from '../middleware/types.js'
import type { LLMProvider, ChatResponse, StreamResult } from '../provider/types.js'
import type { Tool, ToolOutput } from '../tools/types.js'
import type { ToolDefinition } from '@mech/shared'
import { MiddlewarePipeline } from '../middleware/pipeline.js'
import { normalizeMessages } from '../message/normalize.js'
import { buildChatParams } from '../message/builder.js'
import type { AgentMiddleware } from '../middleware/types.js'
import {
  SuspendSignal,
  isSuspendSignal,
  serializeAgentState,
  deserializeAgentState,
} from './hitl.js'
import type { ResumeParams, ToolCallDecision } from './hitl.js'

/** Agent Loop 的运行配置（从 AgentConfig 解构而来） */
export interface LoopConfig {
  provider: LLMProvider
  tools: Tool[]
  system: string
  middleware: AgentMiddleware[]
  maxTurns: number
  cwd: string
}

// ============================================================
// 辅助函数
// ============================================================

/**
 * 将 StreamResult 转换为 AsyncGenerator：
 * - yield 所有流式事件（供 agent.run() 向外转发）
 * - return 最终的 ChatResponse（供 loop 内部使用）
 */
async function* forwardStreamEvents(
  streamResult: StreamResult,
): AsyncGenerator<AgentEvent, ChatResponse, unknown> {
  for await (const event of streamResult.stream) {
    yield event
  }
  return await streamResult.final
}

/** 从 AssistantContentBlock[] 中提取所有 tool_use 块 */
function extractToolCalls(
  content: AssistantContentBlock[],
): Array<{ id: string; name: string; input: Record<string, unknown> }> {
  return content.flatMap((block) => (block.type === 'tool_use' ? [block] : []))
}

/** 累加 usage 到 state */
function accumulateUsage(
  state: AgentState,
  usage: { inputTokens: number; outputTokens: number },
): void {
  state.usage.inputTokens += usage.inputTokens
  state.usage.outputTokens += usage.outputTokens
}

/** 从 AbortSignal 中提取中断原因字符串 */
function getAbortReason(signal: AbortSignal): string {
  return typeof signal.reason === 'string' ? signal.reason : 'user_abort'
}

// ============================================================
// 工具批量执行（含中断捕获）
// ============================================================

/** 工具批量执行的结果 */
type ToolBatchResult =
  | { status: 'completed'; results: Map<string, ToolOutput> }
  | { status: 'suspended'; event: AgentEvent }

/**
 * 执行一批工具调用，统一处理 SuspendSignal 和 AbortSignal 中断。
 * 以 AsyncGenerator 形式 yield tool_executing / tool_result 事件，
 * 最终 return 完成结果或中断事件（suspended）。
 */
async function* executeToolBatch(
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  ctx: RunContext,
  toolMap: Map<string, Tool>,
  wrappedToolCall: ToolCallFn,
  state: AgentState,
  signal: AbortSignal,
  turnIndex: number,
): AsyncGenerator<AgentEvent, ToolBatchResult, unknown> {
  const parallelCalls = toolCalls.filter((c) => toolMap.get(c.name)?.flags.parallelSafe)
  const sequentialCalls = toolCalls.filter((c) => !toolMap.get(c.name)?.flags.parallelSafe)

  // 辅助：生成 checkpoint
  const makeCheckpoint = (
    pendingCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
    reason: string,
    payload?: Record<string, unknown>,
  ): SessionCheckpoint => ({
    state: serializeAgentState(state),
    pendingToolCalls: pendingCalls.map((c) => ({ id: c.id, name: c.name, input: c.input })),
    reason,
    payload,
    turnIndex,
    suspendedAt: Date.now(),
  })

  // 辅助：生成 suspended 事件
  const makeSuspendedEvent = (
    pendingCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
    reason: string,
    payload?: Record<string, unknown>,
  ): AgentEvent => ({
    type: 'suspended',
    checkpoint: makeCheckpoint(pendingCalls, reason, payload),
    reason,
    payload,
  })

  const completedResults = new Map<string, ToolOutput>()

  // ---- 并行工具执行 ----
  if (parallelCalls.length > 0) {
    // 并行工具：先发出所有 tool_executing 事件
    for (const call of parallelCalls) {
      yield { type: 'tool_executing', toolCallId: call.id, toolName: call.name, input: call.input }
    }
    try {
      const results = await Promise.all(
        parallelCalls.map(async (call) => {
          const toolCtx: ToolCallContext = {
            ...ctx,
            toolCallId: call.id,
            toolName: call.name,
            toolInput: call.input,
          }
          const output = await wrappedToolCall(toolCtx)
          return { toolCallId: call.id, toolName: call.name, output }
        }),
      )
      for (const r of results) {
        completedResults.set(r.toolCallId, r.output)
        yield {
          type: 'tool_result',
          toolCallId: r.toolCallId,
          toolName: r.toolName,
          output: r.output.content,
          isError: r.output.isError ?? false,
        }
      }
    } catch (err) {
      // 并行批次中断：整批（parallel + sequential）作为 pending
      const allPending = [...parallelCalls, ...sequentialCalls]
      if (isSuspendSignal(err)) {
        return {
          status: 'suspended',
          event: makeSuspendedEvent(allPending, err.reason, err.payload),
        }
      }
      if (signal.aborted) {
        return {
          status: 'suspended',
          event: makeSuspendedEvent(allPending, getAbortReason(signal)),
        }
      }
      throw err
    }
  }

  // ---- 串行工具执行 ----
  for (let i = 0; i < sequentialCalls.length; i++) {
    const call = sequentialCalls[i]!

    // 执行前检查中止信号
    if (signal.aborted) {
      const pending = sequentialCalls.slice(i)
      return { status: 'suspended', event: makeSuspendedEvent(pending, getAbortReason(signal)) }
    }

    yield { type: 'tool_executing', toolCallId: call.id, toolName: call.name, input: call.input }

    try {
      const toolCtx: ToolCallContext = {
        ...ctx,
        toolCallId: call.id,
        toolName: call.name,
        toolInput: call.input,
      }
      const output = await wrappedToolCall(toolCtx)
      completedResults.set(call.id, output)
      yield {
        type: 'tool_result',
        toolCallId: call.id,
        toolName: call.name,
        output: output.content,
        isError: output.isError ?? false,
      }
    } catch (err) {
      // 当前及后续工具作为 pending
      const pending = sequentialCalls.slice(i)
      if (isSuspendSignal(err)) {
        return { status: 'suspended', event: makeSuspendedEvent(pending, err.reason, err.payload) }
      }
      if (signal.aborted) {
        return { status: 'suspended', event: makeSuspendedEvent(pending, getAbortReason(signal)) }
      }
      throw err
    }
  }

  return { status: 'completed', results: completedResults }
}

// ============================================================
// 主循环引擎（runLoop 和 runLoopFromCheckpoint 共享）
// ============================================================

/** 主循环所需的运行时上下文 */
interface MainLoopContext {
  state: AgentState
  startTurnIndex: number
  maxTurns: number
  system: string
  toolDefinitions: ToolDefinition[]
  toolMap: Map<string, Tool>
  pipeline: MiddlewarePipeline
  wrappedToolCall: ToolCallFn
  wrappedModelCall: ModelCallFn
  ctx: RunContext & { turnIndex: number }
  signal: AbortSignal
}

/**
 * 主循环引擎 —— 编排 LLM 调用 → 工具分发 → 中间件 → 循环。
 * 由 runLoop 和 runLoopFromCheckpoint 共享调用。
 *
 * @returns 最终的 stopReason 和结束时的 turnIndex
 */
async function* runMainLoop(
  loopCtx: MainLoopContext,
): AsyncGenerator<AgentEvent, { stopReason: RunResult['stopReason']; turnIndex: number }> {
  const {
    state,
    startTurnIndex,
    maxTurns,
    system,
    toolDefinitions,
    toolMap,
    pipeline,
    wrappedToolCall,
    wrappedModelCall,
    ctx,
    signal,
  } = loopCtx

  let turnIndex = startTurnIndex
  let stopReason: RunResult['stopReason'] = 'end_turn'

  while (turnIndex < maxTurns) {
    // 检查中止信号（循环顶部：模型调用前，state 干净）
    if (signal.aborted) {
      stopReason = 'abort'
      break
    }

    yield { type: 'turn_start', turnIndex }

    // ---- PREPARE 阶段 ----
    ctx.callMessages = [...state.messages] as typeof ctx.callMessages
    ctx.system = system
    ctx.tools = [...toolDefinitions]
    ctx.lastResponse = undefined

    await pipeline.runBeforeModel(ctx)

    // ---- MODEL CALL 阶段 ----
    const streamResult = await wrappedModelCall(ctx)
    const response: ChatResponse = yield* forwardStreamEvents(streamResult)

    ctx.lastResponse = response
    await pipeline.runAfterModel(ctx)

    // 追加 assistant 消息到真实状态
    state.messages.push({ role: 'assistant', content: response.content })
    accumulateUsage(state, response.usage)

    // ---- DISPATCH 阶段 ----
    const toolCalls = extractToolCalls(response.content)

    if (toolCalls.length === 0) {
      stopReason = 'end_turn'
      yield { type: 'turn_end', turnIndex, usage: response.usage }
      break
    }

    // ---- TOOL CALL 阶段 ----
    const batchResult: ToolBatchResult = yield* executeToolBatch(
      toolCalls,
      ctx,
      toolMap,
      wrappedToolCall,
      state,
      signal,
      turnIndex,
    )

    if (batchResult.status === 'suspended') {
      yield batchResult.event
      stopReason = 'suspended'
      break
    }

    // 按原始顺序追加 tool 结果消息到 state
    for (const call of toolCalls) {
      const output = batchResult.results.get(call.id)
      if (output) {
        state.messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: output.isError ? `Error: ${output.content}` : output.content,
        })
      }
    }

    yield { type: 'turn_end', turnIndex, usage: response.usage }

    turnIndex++

    if (turnIndex >= maxTurns) {
      stopReason = 'max_turns'
      break
    }
  }

  return { stopReason, turnIndex }
}

// ============================================================
// 初始化辅助（runLoop 和 runLoopFromCheckpoint 共享）
// ============================================================

/** 初始化 Loop 运行时所需的公共基础设施 */
function initLoopInfra(
  state: AgentState,
  config: LoopConfig,
  externalSignal: AbortSignal | undefined,
) {
  const { provider, tools, system, middleware, cwd } = config

  const controller = new AbortController()
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason)
    } else {
      externalSignal.addEventListener('abort', () => controller.abort(externalSignal.reason), {
        once: true,
      })
    }
  }
  const signal = controller.signal

  const pipeline = new MiddlewarePipeline(middleware)
  const toolMap = new Map(tools.map((t) => [t.name, t]))
  const toolDefinitions: ToolDefinition[] = tools.map((t) => t.toDefinition())

  // 构建 baseToolCall（工具执行，不含中间件）
  const baseToolCall: ToolCallFn = async (toolCtx) => {
    const tool = toolMap.get(toolCtx.toolName)
    if (!tool) {
      return { content: `工具 "${toolCtx.toolName}" 不存在`, isError: true }
    }
    const validation = await tool.validateInput(toolCtx.toolInput)
    if (!validation.valid) {
      return { content: `输入校验失败: ${validation.error ?? '未知错误'}`, isError: true }
    }
    return tool.execute(toolCtx.toolInput, {
      cwd,
      signal: toolCtx.signal,
      metadata: Object.fromEntries(toolCtx.state.metadata),
    })
  }

  const wrappedToolCall = pipeline.buildToolCallChain(baseToolCall)

  // baseModelCall：将投影字段传给 Provider
  const baseModelCall: ModelCallFn = (callCtx) => {
    const internalMessages = normalizeMessages(callCtx.callMessages)
    const chatParams = buildChatParams({
      messages: internalMessages,
      system: callCtx.system || undefined,
      tools: callCtx.tools.length > 0 ? callCtx.tools : undefined,
    })
    return Promise.resolve(provider.stream(chatParams, { signal: callCtx.signal }))
  }

  const wrappedModelCall = pipeline.buildModelCallChain(baseModelCall)

  return {
    signal,
    pipeline,
    toolMap,
    toolDefinitions,
    wrappedToolCall,
    wrappedModelCall,
    system,
    provider,
  }
}

// ============================================================
// 公共 API
// ============================================================

/**
 * Agent Loop 引擎 —— 编排 LLM 调用 → 工具分发 → 中间件 → 循环的完整周期。
 *
 * 设计要点：
 * - Loop 拥有控制流，中间件只通过 Context 信号影响状态转移
 * - state.messages 是唯一真相，callMessages 是每轮的只读投影
 * - 工具错误作为 tool role 消息反馈给 LLM，提供自愈机会
 */
export async function* runLoop(params: RunParams, config: LoopConfig): AsyncGenerator<AgentEvent> {
  const { state, signal: externalSignal } = params
  const maxTurns = params.maxTurns ?? config.maxTurns
  const usageAtStart = { ...state.usage }

  const infra = initLoopInfra(state, config, externalSignal)
  const { signal, pipeline, toolMap, toolDefinitions, wrappedToolCall, wrappedModelCall, system } =
    infra

  let turnIndex = 0

  const ctx: RunContext & { turnIndex: number } = {
    state,
    callMessages: [],
    system,
    tools: toolDefinitions,
    lastResponse: undefined,
    get turnIndex() {
      return turnIndex
    },
    provider: infra.provider,
    signal,
  }

  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  yield { type: 'agent_run_start', runId, messages: state.messages }

  let stopReason: RunResult['stopReason'] = 'end_turn'

  try {
    await pipeline.runBeforeAgent(ctx)

    const result: { stopReason: RunResult['stopReason']; turnIndex: number } = yield* runMainLoop({
      state,
      startTurnIndex: 0,
      maxTurns,
      system,
      toolDefinitions,
      toolMap,
      pipeline,
      wrappedToolCall,
      wrappedModelCall,
      ctx,
      signal,
    })

    stopReason = result.stopReason
    turnIndex = result.turnIndex
  } catch (err) {
    stopReason = signal.aborted ? 'abort' : 'error'
    throw err
  } finally {
    await pipeline.runAfterAgent(ctx)
  }

  const runUsage = {
    inputTokens: state.usage.inputTokens - usageAtStart.inputTokens,
    outputTokens: state.usage.outputTokens - usageAtStart.outputTokens,
  }

  yield {
    type: 'agent_run_end',
    runId,
    usage: runUsage,
    messages: state.messages,
    stopReason,
  }
}

/**
 * 从 SessionCheckpoint 恢复运行的 Loop。
 * 先处理 pending tool calls（根据 decisions），再进入正常 Loop 循环。
 */
export async function* runLoopFromCheckpoint(
  params: ResumeParams,
  config: LoopConfig,
): AsyncGenerator<AgentEvent> {
  const { checkpoint, decisions } = params
  const { pendingToolCalls, turnIndex: resumeTurnIndex } = checkpoint

  // 从 checkpoint 恢复 AgentState
  const state = deserializeAgentState(checkpoint.state)
  const maxTurns = params.maxTurns ?? config.maxTurns
  const usageAtStart = { ...state.usage }

  const infra = initLoopInfra(state, config, params.signal)
  const { signal, pipeline, toolMap, toolDefinitions, wrappedToolCall, wrappedModelCall, system } =
    infra

  let turnIndex = resumeTurnIndex

  const ctx: RunContext & { turnIndex: number } = {
    state,
    callMessages: [],
    system,
    tools: toolDefinitions,
    lastResponse: undefined,
    get turnIndex() {
      return turnIndex
    },
    provider: infra.provider,
    signal,
  }

  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  yield { type: 'agent_run_start', runId, messages: state.messages }

  let stopReason: RunResult['stopReason'] = 'end_turn'

  try {
    await pipeline.runBeforeAgent(ctx)

    // === 阶段 1：处理 pending tool calls ===
    for (const call of pendingToolCalls) {
      const decision: ToolCallDecision | undefined = decisions[call.id]

      if (!decision || decision.action === 'approve') {
        // 批准：正常执行
        const toolCtx: ToolCallContext = {
          ...ctx,
          toolCallId: call.id,
          toolName: call.name,
          toolInput: call.input,
        }
        const output = await wrappedToolCall(toolCtx)
        state.messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: output.isError ? `Error: ${output.content}` : output.content,
        })
      } else if (decision.action === 'deny') {
        // 拒绝：写入拒绝消息
        state.messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: `Error: 用户拒绝执行此操作${decision.reason ? ': ' + decision.reason : ''}`,
        })
      } else if (decision.action === 'modify') {
        // 修改参数后执行
        const toolCtx: ToolCallContext = {
          ...ctx,
          toolCallId: call.id,
          toolName: call.name,
          toolInput: decision.input,
        }
        const output = await wrappedToolCall(toolCtx)
        state.messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: output.isError ? `Error: ${output.content}` : output.content,
        })
      }
    }

    // === 阶段 2：进入正常 Loop 循环（从下一轮开始） ===
    const result: { stopReason: RunResult['stopReason']; turnIndex: number } = yield* runMainLoop({
      state,
      startTurnIndex: resumeTurnIndex + 1,
      maxTurns,
      system,
      toolDefinitions,
      toolMap,
      pipeline,
      wrappedToolCall,
      wrappedModelCall,
      ctx,
      signal,
    })

    stopReason = result.stopReason
    turnIndex = result.turnIndex
  } catch (err) {
    stopReason = signal.aborted ? 'abort' : 'error'
    throw err
  } finally {
    await pipeline.runAfterAgent(ctx)
  }

  const runUsage = {
    inputTokens: state.usage.inputTokens - usageAtStart.inputTokens,
    outputTokens: state.usage.outputTokens - usageAtStart.outputTokens,
  }

  yield {
    type: 'agent_run_end',
    runId,
    usage: runUsage,
    messages: state.messages,
    stopReason,
  }
}

export { SuspendSignal, isSuspendSignal, serializeAgentState, deserializeAgentState }
export type { ResumeParams }
