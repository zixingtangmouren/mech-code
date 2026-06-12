import type { AgentEvent, AssistantContentBlock, SessionCheckpoint } from '@mech-code/shared'
import type { AgentState } from './state.js'
import type { RunParams, RunResult } from './types.js'
import type {
  AgentLoopState,
  AgentMiddleware,
  AgentRuntime,
  RunContext,
  ToolCallContext,
  ModelCallHandler,
  ToolCallHandler,
  ModelCallRequest,
  ToolCallRequest,
} from '../middleware/types.js'
import type { LLMProvider, ChatResponse, StreamResult } from '../provider/types.js'
import type { Tool, ToolOutput } from '../tools/types.js'
import type { ToolDefinition } from '@mech-code/shared'
import { MiddlewarePipeline } from '../middleware/pipeline.js'
import { buildChatParams } from '../message/builder.js'
import { SuspendSignal, isSuspendSignal } from './hitl.js'
import { deserializeAgentState, serializeAgentState } from './state.js'
import { AssistantMessage, ToolMessage } from '../message/message.js'
import type { ResumeParams, ToolCallDecision } from './hitl.js'

/** Agent Loop 的运行配置（从 AgentConfig 解构而来） */
export interface LoopConfig {
  provider: LLMProvider
  tools: Tool[]
  system: string
  middleware: AgentMiddleware[]
  maxTurns: number
}

type ToolCall = { id: string; name: string; input: Record<string, unknown> }

type ToolBatchResult =
  | { status: 'completed'; results: Map<string, ToolOutput> }
  | { status: 'suspended'; event: AgentEvent }

interface InitLoopInfraResult {
  signal: AbortSignal
  pipeline: MiddlewarePipeline
  toolMap: Map<string, Tool>
  toolDefinitions: ToolDefinition[]
  wrappedToolCall: ToolCallHandler
  wrappedModelCall: ModelCallHandler
  provider: LLMProvider
}

interface StateTracker {
  notify(reason: string, keys?: string[]): void
  flush(reason: string): AgentEvent | undefined
}

interface MainLoopContext {
  maxTurns: number
  pipeline: MiddlewarePipeline
  wrappedToolCall: ToolCallHandler
  wrappedModelCall: ModelCallHandler
  toolMap: Map<string, Tool>
  ctx: RunContext
  tracker: StateTracker
}

const runtimeEventQueues = new WeakMap<AgentRuntime, AgentEvent[]>()

async function* forwardStreamEvents(
  streamResult: StreamResult,
): AsyncGenerator<AgentEvent, ChatResponse, unknown> {
  for await (const event of streamResult.stream) {
    yield event
  }
  return await streamResult.final
}

function extractToolCalls(content: AssistantContentBlock[]): ToolCall[] {
  return content.flatMap((block) => (block.type === 'tool_use' ? [block] : []))
}

function accumulateUsage(
  state: AgentState,
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  },
): void {
  state.usage.inputTokens += usage.inputTokens
  state.usage.outputTokens += usage.outputTokens
  if (usage.cacheReadTokens !== undefined) {
    state.usage.cacheReadTokens = (state.usage.cacheReadTokens ?? 0) + usage.cacheReadTokens
  }
  if (usage.cacheWriteTokens !== undefined) {
    state.usage.cacheWriteTokens = (state.usage.cacheWriteTokens ?? 0) + usage.cacheWriteTokens
  }
}

function getAbortReason(signal: AbortSignal): string {
  return typeof signal.reason === 'string' ? signal.reason : 'user_abort'
}

function getTopLevelKeys(state: AgentState): string[] {
  return Object.keys(state).sort()
}

function stableSerialize(value: unknown): string {
  return (
    JSON.stringify(value, (_key: string, current: unknown): unknown => {
      if (!current || typeof current !== 'object' || Array.isArray(current)) return current
      const record = current as Record<string, unknown>
      return Object.keys(record)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = record[key]
          return acc
        }, {})
    }) ?? '__undefined__'
  )
}

function snapshotState(state: AgentState): Map<string, string> {
  const snapshot = new Map<string, string>()
  for (const key of getTopLevelKeys(state)) {
    snapshot.set(key, stableSerialize(state[key]))
  }
  return snapshot
}

function diffState(prev: Map<string, string>, state: AgentState): string[] {
  const keys = new Set([...prev.keys(), ...getTopLevelKeys(state)])
  const changed: string[] = []
  for (const key of keys) {
    const next = stableSerialize(state[key])
    if (prev.get(key) !== next) changed.push(key)
  }
  return changed.sort()
}

function createStateTracker(
  state: AgentState,
  runId: string,
  loopState: AgentLoopState,
): StateTracker {
  let snapshot = snapshotState(state)
  let pendingKeys = new Set<string>()
  let pendingReason: string | undefined

  return {
    notify(reason, keys) {
      pendingReason = reason
      for (const key of keys ?? []) pendingKeys.add(key)
    },
    flush(reason) {
      const changedKeys = new Set(diffState(snapshot, state))
      for (const key of pendingKeys) changedKeys.add(key)
      pendingKeys = new Set<string>()
      if (changedKeys.size === 0) {
        pendingReason = undefined
        return undefined
      }
      loopState.stateRevision += 1
      snapshot = snapshotState(state)
      const event: AgentEvent = {
        type: 'state_changed',
        runId,
        revision: loopState.stateRevision,
        changedKeys: Array.from(changedKeys).sort(),
        reason: pendingReason ?? reason,
        state: serializeAgentState(state),
      }
      pendingReason = undefined
      return event
    },
  }
}

function flushRuntimeEvents(ctx: RunContext): AgentEvent[] {
  const queue = runtimeEventQueues.get(ctx.runtime)
  if (!queue?.length) return []
  return queue.splice(0)
}

function bindMiddlewareState(state: AgentState, middleware: AgentMiddleware[]): void {
  for (const mw of middleware) {
    if (!mw.state) continue
    for (const [key, value] of Object.entries(mw.state)) {
      if (!(key in state)) {
        state[key] = structuredClone(value)
      }
    }
  }
}

/**
 * 1. 绑定中间件状态
 * 2. 创建统一的 signal，监听外部 signal 的 abort 事件
 * 3. 收集工具定义，检查工具名称冲突
 * 4. 构建工具调用链和模型调用链的执行函数
 * @param state
 * @param config
 * @param externalSignal
 * @returns
 */
function initLoopInfra(
  state: AgentState,
  config: LoopConfig,
  externalSignal: AbortSignal | undefined,
): InitLoopInfraResult {
  const { provider, tools, middleware } = config

  bindMiddlewareState(state, middleware)

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
  const toolMap = new Map<string, Tool>()
  const toolSourceMap = new Map<string, string>()

  for (const tool of tools) {
    if (toolMap.has(tool.name)) {
      throw new Error(`工具名称冲突: "${tool.name}" 在 AgentConfig.tools 中重复定义`)
    }
    toolMap.set(tool.name, tool)
    toolSourceMap.set(tool.name, '__config__')
  }

  for (const { tool, source } of pipeline.collectMiddlewareTools()) {
    if (toolMap.has(tool.name)) {
      const existingSource = toolSourceMap.get(tool.name)!
      throw new Error(
        `工具名称冲突: "${tool.name}" 已由 ${
          existingSource === '__config__' ? 'AgentConfig.tools' : `中间件 "${existingSource}"`
        } 注册，` + `中间件 "${source}" 不能重复注册同名工具`,
      )
    }
    toolMap.set(tool.name, tool)
    toolSourceMap.set(tool.name, source)
  }

  const toolDefinitions = Array.from(toolMap.values()).map((tool) => tool.toDefinition())

  const baseToolCall: ToolCallHandler = async (request) => {
    const tool = request.tool ?? toolMap.get(request.toolName)
    if (!tool) {
      return { content: `工具 "${request.toolName}" 不存在`, isError: true }
    }
    const validation = await tool.validateInput(request.toolInput)
    if (!validation.valid) {
      return { content: `输入校验失败: ${validation.error ?? '未知错误'}`, isError: true }
    }
    const toolCtx: ToolCallContext = {
      ...request.context,
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      toolInput: request.toolInput,
    }
    return tool.execute(request.toolInput, toolCtx)
  }

  const wrappedToolCall = pipeline.buildToolCallChain(baseToolCall)

  const baseModelCall: ModelCallHandler = (request) => {
    return Promise.resolve(request.provider.stream(request.params, request.options))
  }

  const wrappedModelCall = pipeline.buildModelCallChain(baseModelCall)

  return {
    signal,
    pipeline,
    toolMap,
    toolDefinitions,
    wrappedToolCall,
    wrappedModelCall,
    provider,
  }
}

/**
 * 创建 Agent Loop 的运行上下文，包括：
 * 1. 运行时上下文（RunContext），包含 state、props、runtime 和 loopState
 * 2. loopState 包含 turnIndex、stopReason、lastResponse、pendingToolCalls 和 stateRevision
 * 3. runtime 包含 provider、system、tools、middleware、signal 和 emit 方法
 * @param args
 * @returns
 */
function createRunContext(args: {
  state: AgentState
  props: Readonly<Record<string, unknown>>
  runId: string
  provider: LLMProvider
  system: string
  tools: ToolDefinition[]
  middleware: AgentMiddleware[]
  signal: AbortSignal
  initialTurnIndex: number
  notifyStateChanged: (reason: string, keys?: string[]) => void
}): RunContext {
  const loopState: AgentLoopState = {
    turnIndex: args.initialTurnIndex,
    stopReason: 'end_turn',
    lastResponse: undefined,
    pendingToolCalls: [],
    stateRevision: 0,
  }
  const eventQueue: AgentEvent[] = []

  const runtime: AgentRuntime = {
    runId: args.runId,
    provider: args.provider,
    system: args.system,
    tools: [...args.tools],
    middleware: args.middleware,
    signal: args.signal,
    emit(event) {
      eventQueue.push(event)
    },
    notifyStateChanged(reason, keys) {
      args.notifyStateChanged(reason, keys)
    },
  }
  runtimeEventQueues.set(runtime, eventQueue)

  return {
    state: args.state,
    props: args.props,
    runtime,
    loopState,
  }
}

function createModelCallRequest(ctx: RunContext): ModelCallRequest {
  const params = buildChatParams({
    messages: ctx.state.messages,
    system: ctx.runtime.system || undefined,
    tools: ctx.runtime.tools.length > 0 ? ctx.runtime.tools : undefined,
  })
  return {
    context: ctx,
    provider: ctx.runtime.provider,
    params,
    options: { signal: ctx.runtime.signal },
  }
}

function createToolCallRequest(ctx: RunContext, call: ToolCall): ToolCallRequest {
  return {
    context: ctx,
    toolCallId: call.id,
    toolName: call.name,
    toolInput: call.input,
  }
}

/**
 * 1. 发送累计的 AgentEvent 事件
 * 2. 发送 stateChange 事件
 * @param ctx
 * @param tracker
 * @param reason
 */
function* flushBoundary(
  ctx: RunContext,
  tracker: StateTracker,
  reason: string,
): Generator<AgentEvent> {
  for (const event of flushRuntimeEvents(ctx)) yield event
  const stateEvent = tracker.flush(reason)
  if (stateEvent) yield stateEvent
}

function makeCheckpoint(
  ctx: RunContext,
  pendingCalls: ToolCall[],
  reason: string,
  payload?: Record<string, unknown>,
): SessionCheckpoint {
  return {
    state: serializeAgentState(ctx.state),
    pendingToolCalls: pendingCalls.map((call) => ({
      id: call.id,
      name: call.name,
      input: call.input,
    })),
    reason,
    payload,
    turnIndex: ctx.loopState.turnIndex,
    suspendedAt: Date.now(),
  }
}

function makeSuspendedEvent(
  ctx: RunContext,
  pendingCalls: ToolCall[],
  reason: string,
  payload?: Record<string, unknown>,
): AgentEvent {
  return {
    type: 'suspended',
    checkpoint: makeCheckpoint(ctx, pendingCalls, reason, payload),
    reason,
    payload,
  }
}

async function* executeToolBatch(
  toolCalls: ToolCall[],
  ctx: RunContext,
  toolMap: Map<string, Tool>,
  wrappedToolCall: ToolCallHandler,
): AsyncGenerator<AgentEvent, ToolBatchResult, unknown> {
  const parallelCalls = toolCalls.filter((call) => toolMap.get(call.name)?.flags.parallelSafe)
  const sequentialCalls = toolCalls.filter((call) => !toolMap.get(call.name)?.flags.parallelSafe)
  const completedResults = new Map<string, ToolOutput>()

  if (parallelCalls.length > 0) {
    for (const call of parallelCalls) {
      yield { type: 'tool_executing', toolCallId: call.id, toolName: call.name, input: call.input }
    }
    try {
      const results = await Promise.all(
        parallelCalls.map(async (call) => {
          const output = await wrappedToolCall(createToolCallRequest(ctx, call))
          return { toolCallId: call.id, toolName: call.name, output }
        }),
      )
      for (const result of results) {
        completedResults.set(result.toolCallId, result.output)
        yield {
          type: 'tool_result',
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          output: result.output.content,
          isError: result.output.isError ?? false,
        }
      }
    } catch (err) {
      const pending = [...parallelCalls, ...sequentialCalls]
      if (isSuspendSignal(err)) {
        return {
          status: 'suspended',
          event: makeSuspendedEvent(ctx, pending, err.reason, err.payload),
        }
      }
      if (ctx.runtime.signal.aborted) {
        return {
          status: 'suspended',
          event: makeSuspendedEvent(ctx, pending, getAbortReason(ctx.runtime.signal)),
        }
      }
      throw err
    }
  }

  for (let index = 0; index < sequentialCalls.length; index++) {
    const call = sequentialCalls[index]!
    if (ctx.runtime.signal.aborted) {
      return {
        status: 'suspended',
        event: makeSuspendedEvent(
          ctx,
          sequentialCalls.slice(index),
          getAbortReason(ctx.runtime.signal),
        ),
      }
    }

    yield { type: 'tool_executing', toolCallId: call.id, toolName: call.name, input: call.input }

    try {
      const output = await wrappedToolCall(createToolCallRequest(ctx, call))
      completedResults.set(call.id, output)
      yield {
        type: 'tool_result',
        toolCallId: call.id,
        toolName: call.name,
        output: output.content,
        isError: output.isError ?? false,
      }
    } catch (err) {
      const pending = sequentialCalls.slice(index)
      if (isSuspendSignal(err)) {
        return {
          status: 'suspended',
          event: makeSuspendedEvent(ctx, pending, err.reason, err.payload),
        }
      }
      if (ctx.runtime.signal.aborted) {
        return {
          status: 'suspended',
          event: makeSuspendedEvent(ctx, pending, getAbortReason(ctx.runtime.signal)),
        }
      }
      throw err
    }
  }

  return { status: 'completed', results: completedResults }
}

function appendToolMessages(
  ctx: RunContext,
  toolCalls: ToolCall[],
  results: Map<string, ToolOutput>,
): void {
  for (const call of toolCalls) {
    const output = results.get(call.id)
    if (!output) continue
    const metadata: Record<string, unknown> = {}
    if (output.metadata?.type === 'image' && typeof output.metadata.base64 === 'string') {
      metadata.imageData = {
        base64: output.metadata.base64,
        mediaType: output.metadata.mediaType as string,
      }
    }
    const toolMessage = new ToolMessage(
      call.id,
      call.name,
      output.isError ? `Error: ${output.content}` : output.content,
      { metadata },
    )
    ctx.state.messages.push(toolMessage)
  }
}

async function* runMainLoop(
  loopCtx: MainLoopContext,
): AsyncGenerator<AgentEvent, { stopReason: RunResult['stopReason']; turnIndex: number }> {
  const { maxTurns, pipeline, wrappedToolCall, wrappedModelCall, toolMap, ctx, tracker } = loopCtx
  const loopState = ctx.loopState

  while (loopState.turnIndex < maxTurns) {
    if (ctx.runtime.signal.aborted) {
      loopState.stopReason = 'abort'
      break
    }

    yield { type: 'turn_start', turnIndex: loopState.turnIndex }

    loopState.lastResponse = undefined
    await pipeline.runBeforeModel(ctx)
    yield* flushBoundary(ctx, tracker, 'before_model')

    const streamResult = await wrappedModelCall(createModelCallRequest(ctx))
    const response = yield* forwardStreamEvents(streamResult)

    loopState.lastResponse = response
    await pipeline.runAfterModel(ctx)
    yield* flushBoundary(ctx, tracker, 'after_model')

    ctx.state.messages.push(new AssistantMessage(response.content))
    accumulateUsage(ctx.state, response.usage)
    yield* flushBoundary(ctx, tracker, 'assistant_message')

    const toolCalls = extractToolCalls(response.content)
    loopState.pendingToolCalls = toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      input: call.input,
    }))

    if (toolCalls.length === 0) {
      loopState.stopReason = 'end_turn'
      yield { type: 'turn_end', turnIndex: loopState.turnIndex, usage: response.usage }
      yield* flushBoundary(ctx, tracker, 'turn_end')
      break
    }

    const batchResult = yield* executeToolBatch(toolCalls, ctx, toolMap, wrappedToolCall)
    yield* flushBoundary(ctx, tracker, 'tool_batch')

    if (batchResult.status === 'suspended') {
      yield batchResult.event
      loopState.stopReason = 'suspended'
      break
    }

    appendToolMessages(ctx, toolCalls, batchResult.results)
    loopState.pendingToolCalls = []
    yield* flushBoundary(ctx, tracker, 'tool_messages')

    yield { type: 'turn_end', turnIndex: loopState.turnIndex, usage: response.usage }
    yield* flushBoundary(ctx, tracker, 'turn_end')

    loopState.turnIndex++
    if (loopState.turnIndex >= maxTurns) {
      loopState.stopReason = 'max_turns'
      break
    }
  }

  return { stopReason: loopState.stopReason, turnIndex: loopState.turnIndex }
}

export async function* runLoop(params: RunParams, config: LoopConfig): AsyncGenerator<AgentEvent> {
  const { state, props: callerProps } = params
  const maxTurns = params.config?.maxTurns ?? config.maxTurns
  const externalSignal = params.config?.signal
  const usageAtStart = { ...state.usage }
  const infra = initLoopInfra(state, config, externalSignal)
  const props = Object.freeze(callerProps ?? {})
  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`

  const trackerRef: { current?: StateTracker } = {}
  const ctx = createRunContext({
    state,
    props,
    runId,
    provider: infra.provider,
    system: config.system,
    tools: infra.toolDefinitions,
    middleware: config.middleware,
    signal: infra.signal,
    initialTurnIndex: 0,
    notifyStateChanged(reason, keys) {
      trackerRef.current?.notify(reason, keys)
    },
  })
  const tracker = createStateTracker(state, runId, ctx.loopState)
  trackerRef.current = tracker

  yield { type: 'agent_run_start', runId, messages: state.messages }
  yield* flushBoundary(ctx, tracker, 'agent_run_start')

  try {
    await infra.pipeline.runBeforeAgent(ctx)
    yield* flushBoundary(ctx, tracker, 'before_agent')

    yield* runMainLoop({
      maxTurns,
      pipeline: infra.pipeline,
      wrappedToolCall: infra.wrappedToolCall,
      wrappedModelCall: infra.wrappedModelCall,
      toolMap: infra.toolMap,
      ctx,
      tracker,
    })
  } catch (err) {
    ctx.loopState.stopReason = infra.signal.aborted ? 'abort' : 'error'
    throw err
  } finally {
    await infra.pipeline.runAfterAgent(ctx)
    yield* flushBoundary(ctx, tracker, 'after_agent')
  }

  const runUsage = {
    inputTokens: state.usage.inputTokens - usageAtStart.inputTokens,
    outputTokens: state.usage.outputTokens - usageAtStart.outputTokens,
    cacheReadTokens: (state.usage.cacheReadTokens ?? 0) - (usageAtStart.cacheReadTokens ?? 0),
    cacheWriteTokens: (state.usage.cacheWriteTokens ?? 0) - (usageAtStart.cacheWriteTokens ?? 0),
  }

  yield {
    type: 'agent_run_end',
    runId,
    usage: runUsage,
    messages: state.messages,
    stopReason: ctx.loopState.stopReason,
  }
  yield* flushBoundary(ctx, tracker, 'agent_run_end')
}

export async function* runLoopFromCheckpoint(
  params: ResumeParams,
  config: LoopConfig,
): AsyncGenerator<AgentEvent> {
  const { checkpoint, decisions } = params
  const { pendingToolCalls, turnIndex: resumeTurnIndex } = checkpoint
  const state = deserializeAgentState(checkpoint.state)
  const maxTurns = params.config?.maxTurns ?? config.maxTurns
  const externalSignal = params.config?.signal
  const usageAtStart = { ...state.usage }
  const infra = initLoopInfra(state, config, externalSignal)
  const props = Object.freeze(params.props ?? {})
  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`

  const trackerRef: { current?: StateTracker } = {}
  const ctx = createRunContext({
    state,
    props,
    runId,
    provider: infra.provider,
    system: config.system,
    tools: infra.toolDefinitions,
    middleware: config.middleware,
    signal: infra.signal,
    initialTurnIndex: resumeTurnIndex,
    notifyStateChanged(reason, keys) {
      trackerRef.current?.notify(reason, keys)
    },
  })
  const tracker = createStateTracker(state, runId, ctx.loopState)
  trackerRef.current = tracker

  yield { type: 'agent_run_start', runId, messages: state.messages }
  yield* flushBoundary(ctx, tracker, 'agent_run_start')

  try {
    await infra.pipeline.runBeforeAgent(ctx)
    yield* flushBoundary(ctx, tracker, 'before_agent')

    for (const call of pendingToolCalls) {
      const decision: ToolCallDecision | undefined = decisions[call.id]
      if (decision?.action === 'deny') {
        state.messages.push(
          new ToolMessage(
            call.id,
            call.name,
            `Error: 用户拒绝执行此操作${decision.reason ? ': ' + decision.reason : ''}`,
          ),
        )
        continue
      }

      const input = decision?.action === 'modify' ? decision.input : call.input
      const output = await infra.wrappedToolCall(
        createToolCallRequest(ctx, {
          id: call.id,
          name: call.name,
          input,
        }),
      )
      state.messages.push(
        new ToolMessage(
          call.id,
          call.name,
          output.isError ? `Error: ${output.content}` : output.content,
        ),
      )
    }
    ctx.loopState.pendingToolCalls = []
    yield* flushBoundary(ctx, tracker, 'resume_pending_tools')

    ctx.loopState.turnIndex = resumeTurnIndex + 1
    yield* runMainLoop({
      maxTurns,
      pipeline: infra.pipeline,
      wrappedToolCall: infra.wrappedToolCall,
      wrappedModelCall: infra.wrappedModelCall,
      toolMap: infra.toolMap,
      ctx,
      tracker,
    })
  } catch (err) {
    ctx.loopState.stopReason = infra.signal.aborted ? 'abort' : 'error'
    throw err
  } finally {
    await infra.pipeline.runAfterAgent(ctx)
    yield* flushBoundary(ctx, tracker, 'after_agent')
  }

  const runUsage = {
    inputTokens: state.usage.inputTokens - usageAtStart.inputTokens,
    outputTokens: state.usage.outputTokens - usageAtStart.outputTokens,
    cacheReadTokens: (state.usage.cacheReadTokens ?? 0) - (usageAtStart.cacheReadTokens ?? 0),
    cacheWriteTokens: (state.usage.cacheWriteTokens ?? 0) - (usageAtStart.cacheWriteTokens ?? 0),
  }

  yield {
    type: 'agent_run_end',
    runId,
    usage: runUsage,
    messages: state.messages,
    stopReason: ctx.loopState.stopReason,
  }
  yield* flushBoundary(ctx, tracker, 'agent_run_end')
}

export { SuspendSignal, isSuspendSignal, serializeAgentState, deserializeAgentState }
export type { ResumeParams }
