import type { AgentEvent, AssistantContentBlock } from '@mech/shared'
import type { AgentState, RunParams, RunResult } from './types.js'
import type { RunContext, ToolExecContext, LLMCallFn, ToolExecFn } from '../middleware/types.js'
import type { LLMProvider, ChatResponse, StreamResult } from '../provider/types.js'
import type { Tool, ToolOutput } from '../tools/types.js'
import type { ToolDefinition } from '@mech/shared'
import { MiddlewarePipeline } from '../middleware/pipeline.js'
import { normalizeMessages } from '../message/normalize.js'
import { buildChatParams } from '../message/builder.js'
import type { AgentMiddleware } from '../middleware/types.js'

/** Agent Loop 的运行配置（从 AgentConfig 解构而来） */
export interface LoopConfig {
  provider: LLMProvider
  tools: Tool[]
  system: string
  middleware: AgentMiddleware[]
  maxTurns: number
  cwd: string
}

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

/**
 * 执行单个工具调用（含中间件 Hook + Wrap 链）。
 * 返回工具输出，并在 ctx.toolResult 上设置结果（供 afterToolExec 读取）。
 */
async function executeToolCall(
  call: { id: string; name: string; input: Record<string, unknown> },
  runCtx: RunContext,
  toolMap: Map<string, Tool>,
  pipeline: MiddlewarePipeline,
  wrappedToolExec: ToolExecFn,
  _cwd: string,
): Promise<{ toolCallId: string; output: ToolOutput }> {
  // 构建 ToolExecContext
  const toolCtx: ToolExecContext = {
    ...runCtx,
    toolCallId: call.id,
    toolName: call.name,
    toolInput: call.input,
    toolResult: undefined,
    skipExecution: false,
    overrideResult: undefined,
  }

  // beforeToolExec hooks（某个中间件设置 skipExecution 后链会中断）
  await pipeline.runBeforeToolExec(toolCtx)

  let output: ToolOutput

  if (toolCtx.skipExecution) {
    // 中间件要求跳过执行（如权限拒绝）
    output = toolCtx.overrideResult ?? { content: '工具执行已被跳过', isError: true }
  } else {
    output = await wrappedToolExec(toolCtx)
  }

  // 回写 toolResult 供 afterToolExec 读取
  toolCtx.toolResult = output

  // afterToolExec hooks
  await pipeline.runAfterToolExec(toolCtx)

  // 若中间件在 afterToolExec 中修改了 toolResult，使用修改后的结果
  return { toolCallId: call.id, output: toolCtx.toolResult ?? output }
}

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
  const { provider, tools, system, middleware, cwd } = config
  const maxTurns = params.maxTurns ?? config.maxTurns

  // 内部 AbortController，用于主动终止
  // 若有外部 signal，监听其 abort 事件同步触发内部 controller
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

  // 记录 run 开始时的 usage，用于计算本次增量
  const usageAtStart = { ...state.usage }

  // 可变轮次计数器（readonly 在 RunContext 中，但 loop 内部需要递增）
  let turnIndex = 0
  let stopReason: RunResult['stopReason'] = 'end_turn'

  // 构建 ToolDefinition 列表（loop 内保持固定，中间件通过 ctx.tools 临时修改）
  const toolDefinitions: ToolDefinition[] = tools.map((t) => t.toDefinition())

  /** 构造每轮共享的 RunContext 基础对象（turnIndex 由 loop 更新） */
  const makeContext = (): RunContext & { turnIndex: number } => ({
    state,
    callMessages: [],
    system,
    tools: toolDefinitions,
    lastResponse: undefined,
    get turnIndex() {
      return turnIndex
    },
    provider,
    signal,
  })

  const ctx = makeContext()

  // 构建 baseFn（工具执行，不含中间件）
  const baseToolExec: ToolExecFn = async (toolCtx) => {
    const tool = toolMap.get(toolCtx.toolName)
    if (!tool) {
      return { content: `工具 "${toolCtx.toolName}" 不存在`, isError: true }
    }

    // 业务级约束校验（在 Zod schema 校验之外的运行时约束）
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

  const wrappedToolExec = pipeline.buildToolExecChain(baseToolExec)

  // === RUN START ===
  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  yield { type: 'agent_run_start', runId, messages: state.messages }

  try {
    await pipeline.runOnRunStart(ctx)

    // === MAIN LOOP ===
    while (turnIndex < maxTurns) {
      // 检查中止信号
      if (signal.aborted) {
        stopReason = 'abort'
        break
      }

      yield { type: 'turn_start', turnIndex }

      // ---- PREPARE 阶段 ----
      // 每轮重新生成 callMessages 快照和 system/tools 投影
      ctx.callMessages = [...state.messages] as typeof ctx.callMessages
      ctx.system = system
      ctx.tools = [...toolDefinitions]
      ctx.lastResponse = undefined

      // beforeLLMCall hooks（中间件可修改 callMessages / system / tools）
      await pipeline.runBeforeLLMCall(ctx)

      // ---- LLM CALL 阶段 ----
      // baseLLMCall：将投影字段传给 Provider
      const baseLLMCall: LLMCallFn = (callCtx) => {
        const internalMessages = normalizeMessages(callCtx.callMessages)
        const chatParams = buildChatParams({
          messages: internalMessages,
          system: callCtx.system || undefined,
          tools: callCtx.tools.length > 0 ? callCtx.tools : undefined,
        })
        return provider.stream(chatParams, { signal: callCtx.signal })
      }

      const wrappedLLMCall = pipeline.buildLLMCallChain(baseLLMCall)
      const streamResult = await wrappedLLMCall(ctx)

      // 转发流式事件，同时等待完整响应
      const response: ChatResponse = yield* forwardStreamEvents(streamResult)

      // 将 LLM 响应写入 ctx，供 afterLLMResponse 读取
      ctx.lastResponse = response

      // afterLLMResponse hooks
      await pipeline.runAfterLLMResponse(ctx)

      // 追加 assistant 消息到真实状态
      state.messages.push({ role: 'assistant', content: response.content })
      accumulateUsage(state, response.usage)

      // ---- DISPATCH 阶段 ----
      const toolCalls = extractToolCalls(response.content)

      if (toolCalls.length === 0) {
        // LLM 没有发起工具调用，本轮结束
        stopReason = 'end_turn'
        await pipeline.runOnTurnEnd(ctx)
        yield { type: 'turn_end', turnIndex, usage: response.usage }
        break
      }

      // ---- TOOL EXEC 阶段 ----
      // 按 parallelSafe 分组：并发安全的工具并行执行，其余串行
      const parallelCalls = toolCalls.filter((c) => toolMap.get(c.name)?.flags.parallelSafe)
      const sequentialCalls = toolCalls.filter((c) => !toolMap.get(c.name)?.flags.parallelSafe)

      // 执行并发安全的工具
      const parallelResults = await Promise.all(
        parallelCalls.map((call) =>
          executeToolCall(call, ctx, toolMap, pipeline, wrappedToolExec, cwd),
        ),
      )

      // 执行非并发安全的工具（串行）
      const sequentialResults: Array<{ toolCallId: string; output: ToolOutput }> = []
      for (const call of sequentialCalls) {
        const result = await executeToolCall(call, ctx, toolMap, pipeline, wrappedToolExec, cwd)
        sequentialResults.push(result)
      }

      // 按原始顺序追加 tool 结果消息到 state
      const allResults = new Map([
        ...parallelResults.map((r) => [r.toolCallId, r.output] as const),
        ...sequentialResults.map((r) => [r.toolCallId, r.output] as const),
      ])

      for (const call of toolCalls) {
        const output = allResults.get(call.id)
        if (output) {
          state.messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: output.isError ? `Error: ${output.content}` : output.content,
          })
        }
      }

      // 本轮结束，检查是否达到 maxTurns
      await pipeline.runOnTurnEnd(ctx)
      yield { type: 'turn_end', turnIndex, usage: response.usage }

      turnIndex++

      if (turnIndex >= maxTurns) {
        stopReason = 'max_turns'
        break
      }
    }
  } catch (err) {
    stopReason = signal.aborted ? 'abort' : 'error'
    // 将错误向上传播，由 agent.run() 的消费方处理
    throw err
  } finally {
    // onRunEnd 类似 finally，即使出错也执行
    await pipeline.runOnRunEnd(ctx)
  }

  // === RUN END ===
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
