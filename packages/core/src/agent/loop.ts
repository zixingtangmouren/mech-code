import type {
  AgentEvent,
  AssistantContentBlock,
  CustomAgentEvent,
  ImageSource,
  PendingToolCall,
  SerializableRuntimeState,
  SessionCheckpoint,
} from '@mech-code/shared'
import type { AgentState } from './state.js'
import type { RunParams, RunResult } from './types.js'
import type {
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

interface MainLoopContext {
  maxTurns: number
  pipeline: MiddlewarePipeline
  wrappedToolCall: ToolCallHandler
  wrappedModelCall: ModelCallHandler
  toolMap: Map<string, Tool>
  ctx: RunContext
  runtimeHandle: RuntimeHandle
}

interface RuntimeHandle {
  readonly runtime: AgentRuntime
  readonly turnIndex: number
  readonly stopReason: RunResult['stopReason']
  setTurnIndex(turnIndex: number): void
  setStopReason(stopReason: RunResult['stopReason']): void
  setLastResponse(response: ChatResponse | undefined): void
  setPendingToolCalls(calls: PendingToolCall[]): void
  createCheckpointState(): SerializableRuntimeState
  drainEvents(): CustomAgentEvent[]
  hasEvents(): boolean
  subscribeEvents(listener: () => void): () => void
}

async function* forwardStreamEvents(
  streamResult: StreamResult,
  runtimeHandle: RuntimeHandle,
): AsyncGenerator<AgentEvent, ChatResponse, unknown> {
  const iterator = streamResult.stream[Symbol.asyncIterator]()
  while (true) {
    const result = yield* awaitRuntimeOperation(iterator.next(), runtimeHandle)
    if (result.done) break
    yield result.value
  }
  return yield* awaitRuntimeOperation(streamResult.final, runtimeHandle)
}

function extractToolCalls(content: AssistantContentBlock[]): ToolCall[] {
  return content.flatMap((block) => (block.type === 'tool_use' ? [block] : []))
}

function getAssistantBlocks(response: ChatResponse): AssistantContentBlock[] {
  return response.message.content
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

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key], seen)
  }
  return Object.freeze(value)
}

function createPendingToolCallsView(
  calls: PendingToolCall[],
): readonly Readonly<PendingToolCall>[] {
  return deepFreeze(structuredClone(calls))
}

function normalizePendingToolCalls(calls: PendingToolCall[]): PendingToolCall[] {
  return calls.map((call) => ({
    id: call.id,
    name: call.name,
    input: structuredClone(call.input),
  }))
}

function createResponseView(response: ChatResponse): Readonly<ChatResponse> {
  return deepFreeze({
    message: new AssistantMessage(structuredClone(response.message.content), {
      metadata: structuredClone(response.message.metadata),
    }),
    usage: structuredClone(response.usage),
    stopReason: response.stopReason,
  })
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

/** 创建框架内部可写、对中间件只读的 runtime。 */
function createRuntimeHandle(args: {
  props: Readonly<Record<string, unknown>>
  runId: string
  provider: LLMProvider
  system: string
  tools: ToolDefinition[]
  middleware: AgentMiddleware[]
  signal: AbortSignal
  checkpointState?: SerializableRuntimeState
}): RuntimeHandle {
  const state: {
    startedAt: number
    turnIndex: number
    stopReason: RunResult['stopReason']
    lastResponse: Readonly<ChatResponse> | undefined
    pendingToolCalls: PendingToolCall[]
  } = {
    startedAt: args.checkpointState?.startedAt ?? Date.now(),
    turnIndex: args.checkpointState?.turnIndex ?? 0,
    stopReason: 'end_turn',
    lastResponse: undefined as Readonly<ChatResponse> | undefined,
    pendingToolCalls: normalizePendingToolCalls(args.checkpointState?.pendingToolCalls ?? []),
  }
  let pendingToolCallsView = createPendingToolCallsView(state.pendingToolCalls)
  const eventQueue: CustomAgentEvent[] = []
  const eventListeners = new Set<() => void>()

  const runtime = Object.freeze<AgentRuntime>({
    runId: args.runId,
    startedAt: state.startedAt,
    props: Object.freeze({ ...args.props }),
    provider: args.provider,
    system: args.system,
    tools: Object.freeze([...args.tools]),
    middleware: Object.freeze([...args.middleware]),
    signal: args.signal,
    get turnIndex() {
      return state.turnIndex
    },
    get stopReason() {
      return state.stopReason
    },
    get lastResponse() {
      return state.lastResponse
    },
    get pendingToolCalls() {
      return pendingToolCallsView
    },
    emitCustomAgentEvent(event) {
      eventQueue.push({
        type: 'custom',
        runId: args.runId,
        turnIndex: state.turnIndex,
        source: event.source,
        name: event.name,
        payload: structuredClone(event.payload),
      })
      for (const listener of eventListeners) listener()
    },
  })

  return {
    runtime,
    get turnIndex() {
      return state.turnIndex
    },
    get stopReason() {
      return state.stopReason
    },
    setTurnIndex(turnIndex) {
      state.turnIndex = turnIndex
    },
    setStopReason(stopReason) {
      state.stopReason = stopReason
    },
    setLastResponse(response) {
      state.lastResponse = response ? createResponseView(response) : undefined
    },
    setPendingToolCalls(calls) {
      state.pendingToolCalls = normalizePendingToolCalls(calls)
      pendingToolCallsView = createPendingToolCallsView(state.pendingToolCalls)
    },
    createCheckpointState() {
      return {
        startedAt: state.startedAt,
        turnIndex: state.turnIndex,
        pendingToolCalls: structuredClone(state.pendingToolCalls),
      }
    },
    drainEvents() {
      return eventQueue.splice(0, eventQueue.length)
    },
    hasEvents() {
      return eventQueue.length > 0
    },
    subscribeEvents(listener) {
      eventListeners.add(listener)
      return () => eventListeners.delete(listener)
    },
  }
}

function createModelCallRequest(ctx: RunContext): ModelCallRequest {
  const params = buildChatParams({
    messages: ctx.state.messages,
    system: ctx.runtime.system || undefined,
    tools: ctx.runtime.tools.length > 0 ? [...ctx.runtime.tools] : undefined,
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

function* drainRuntimeEvents(runtimeHandle: RuntimeHandle): Generator<AgentEvent> {
  for (const event of runtimeHandle.drainEvents()) yield event
}

/** 等待异步框架操作时，持续把中间件事件转发到 Agent 事件流。 */
async function* awaitRuntimeOperation<T>(
  operation: Promise<T>,
  runtimeHandle: RuntimeHandle,
): AsyncGenerator<AgentEvent, T, unknown> {
  let outcome:
    | { status: 'fulfilled'; value: T }
    | { status: 'rejected'; error: unknown }
    | undefined
  let wake: (() => void) | undefined
  const unsubscribe = runtimeHandle.subscribeEvents(() => wake?.())

  void operation.then(
    (value) => {
      outcome = { status: 'fulfilled', value }
      wake?.()
    },
    (error: unknown) => {
      outcome = { status: 'rejected', error }
      wake?.()
    },
  )

  try {
    while (!outcome) {
      yield* drainRuntimeEvents(runtimeHandle)
      if (outcome) break
      if (runtimeHandle.hasEvents()) continue
      await new Promise<void>((resolve) => {
        wake = resolve
        if (outcome) resolve()
      })
      wake = undefined
    }
    yield* drainRuntimeEvents(runtimeHandle)
  } finally {
    unsubscribe()
    wake?.()
  }

  const settled = outcome
  if (!settled) throw new Error('异步运行操作未产生结果')
  if (settled.status === 'rejected') throw settled.error
  return settled.value
}

function makeCheckpoint(
  ctx: RunContext,
  runtimeHandle: RuntimeHandle,
  reason: string,
  payload?: Record<string, unknown>,
): SessionCheckpoint {
  return {
    state: serializeAgentState(ctx.state),
    runtime: runtimeHandle.createCheckpointState(),
    reason,
    payload,
    suspendedAt: Date.now(),
  }
}

function makeSuspendedEvent(
  ctx: RunContext,
  runtimeHandle: RuntimeHandle,
  pendingCalls: ToolCall[],
  reason: string,
  payload?: Record<string, unknown>,
): AgentEvent {
  runtimeHandle.setPendingToolCalls(pendingCalls)
  return {
    type: 'suspended',
    checkpoint: makeCheckpoint(ctx, runtimeHandle, reason, payload),
    reason,
    payload,
  }
}

async function* executeToolBatch(
  toolCalls: ToolCall[],
  ctx: RunContext,
  runtimeHandle: RuntimeHandle,
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
      const results = yield* awaitRuntimeOperation(
        Promise.all(
          parallelCalls.map(async (call) => {
            const output = await wrappedToolCall(createToolCallRequest(ctx, call))
            return { toolCallId: call.id, toolName: call.name, output }
          }),
        ),
        runtimeHandle,
      )
      runtimeHandle.setPendingToolCalls(sequentialCalls)
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
          event: makeSuspendedEvent(ctx, runtimeHandle, pending, err.reason, err.payload),
        }
      }
      if (ctx.runtime.signal.aborted) {
        return {
          status: 'suspended',
          event: makeSuspendedEvent(
            ctx,
            runtimeHandle,
            pending,
            getAbortReason(ctx.runtime.signal),
          ),
        }
      }
      throw err
    }
  }

  for (let index = 0; index < sequentialCalls.length; index++) {
    const call = sequentialCalls[index]!
    runtimeHandle.setPendingToolCalls(sequentialCalls.slice(index))
    if (ctx.runtime.signal.aborted) {
      return {
        status: 'suspended',
        event: makeSuspendedEvent(
          ctx,
          runtimeHandle,
          sequentialCalls.slice(index),
          getAbortReason(ctx.runtime.signal),
        ),
      }
    }

    yield { type: 'tool_executing', toolCallId: call.id, toolName: call.name, input: call.input }

    try {
      const output = yield* awaitRuntimeOperation(
        wrappedToolCall(createToolCallRequest(ctx, call)),
        runtimeHandle,
      )
      completedResults.set(call.id, output)
      runtimeHandle.setPendingToolCalls(sequentialCalls.slice(index + 1))
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
          event: makeSuspendedEvent(ctx, runtimeHandle, pending, err.reason, err.payload),
        }
      }
      if (ctx.runtime.signal.aborted) {
        return {
          status: 'suspended',
          event: makeSuspendedEvent(
            ctx,
            runtimeHandle,
            pending,
            getAbortReason(ctx.runtime.signal),
          ),
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
    let image: ImageSource | undefined
    if (
      output.metadata?.type === 'image' &&
      typeof output.metadata.base64 === 'string' &&
      typeof output.metadata.mediaType === 'string'
    ) {
      image = {
        type: 'base64',
        data: output.metadata.base64,
        mediaType: output.metadata.mediaType,
      }
    }
    const toolMessage = new ToolMessage(
      call.id,
      call.name,
      output.isError ? `Error: ${output.content}` : output.content,
      { image },
    )
    ctx.state.messages.push(toolMessage)
  }
}

async function* runMainLoop(
  loopCtx: MainLoopContext,
): AsyncGenerator<AgentEvent, { stopReason: RunResult['stopReason']; turnIndex: number }> {
  const { maxTurns, pipeline, wrappedToolCall, wrappedModelCall, toolMap, ctx, runtimeHandle } =
    loopCtx

  while (runtimeHandle.turnIndex < maxTurns) {
    if (ctx.runtime.signal.aborted) {
      runtimeHandle.setStopReason('abort')
      break
    }

    yield { type: 'turn_start', turnIndex: runtimeHandle.turnIndex }

    runtimeHandle.setLastResponse(undefined)
    yield* awaitRuntimeOperation(pipeline.runBeforeModel(ctx), runtimeHandle)

    const streamResult = yield* awaitRuntimeOperation(
      wrappedModelCall(createModelCallRequest(ctx)),
      runtimeHandle,
    )
    const response = yield* forwardStreamEvents(streamResult, runtimeHandle)

    runtimeHandle.setLastResponse(response)
    yield* awaitRuntimeOperation(pipeline.runAfterModel(ctx), runtimeHandle)

    ctx.state.messages.push(response.message)
    accumulateUsage(ctx.state, response.usage)

    const toolCalls = extractToolCalls(getAssistantBlocks(response))
    runtimeHandle.setPendingToolCalls(
      toolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        input: call.input,
      })),
    )

    if (toolCalls.length === 0) {
      runtimeHandle.setStopReason('end_turn')
      yield { type: 'turn_end', turnIndex: runtimeHandle.turnIndex, usage: response.usage }
      break
    }

    const batchResult = yield* executeToolBatch(
      toolCalls,
      ctx,
      runtimeHandle,
      toolMap,
      wrappedToolCall,
    )
    if (batchResult.status === 'suspended') {
      yield batchResult.event
      runtimeHandle.setStopReason('suspended')
      break
    }

    appendToolMessages(ctx, toolCalls, batchResult.results)
    runtimeHandle.setPendingToolCalls([])

    yield { type: 'turn_end', turnIndex: runtimeHandle.turnIndex, usage: response.usage }

    runtimeHandle.setTurnIndex(runtimeHandle.turnIndex + 1)
    if (runtimeHandle.turnIndex >= maxTurns) {
      runtimeHandle.setStopReason('max_turns')
      break
    }
  }

  return { stopReason: runtimeHandle.stopReason, turnIndex: runtimeHandle.turnIndex }
}

export async function* runLoop(params: RunParams, config: LoopConfig): AsyncGenerator<AgentEvent> {
  const { state, props: callerProps } = params
  const maxTurns = params.config?.maxTurns ?? config.maxTurns
  const externalSignal = params.config?.signal
  const usageAtStart = { ...state.usage }
  const infra = initLoopInfra(state, config, externalSignal)
  const props = Object.freeze(callerProps ?? {})
  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`

  const runtimeHandle = createRuntimeHandle({
    props,
    runId,
    provider: infra.provider,
    system: config.system,
    tools: infra.toolDefinitions,
    middleware: config.middleware,
    signal: infra.signal,
  })
  const ctx: RunContext = { state, runtime: runtimeHandle.runtime }

  yield { type: 'agent_run_start', runId, messages: state.messages }

  try {
    yield* awaitRuntimeOperation(infra.pipeline.runBeforeAgent(ctx), runtimeHandle)

    yield* runMainLoop({
      maxTurns,
      pipeline: infra.pipeline,
      wrappedToolCall: infra.wrappedToolCall,
      wrappedModelCall: infra.wrappedModelCall,
      toolMap: infra.toolMap,
      ctx,
      runtimeHandle,
    })
  } catch (err) {
    runtimeHandle.setStopReason(infra.signal.aborted ? 'abort' : 'error')
    throw err
  } finally {
    yield* awaitRuntimeOperation(infra.pipeline.runAfterAgent(ctx), runtimeHandle)
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
    state: serializeAgentState(state),
    stopReason: runtimeHandle.stopReason,
  }
}

export async function* runLoopFromCheckpoint(
  params: ResumeParams,
  config: LoopConfig,
): AsyncGenerator<AgentEvent> {
  const { checkpoint, decisions } = params
  const { pendingToolCalls, turnIndex: resumeTurnIndex } = checkpoint.runtime
  const state = deserializeAgentState(checkpoint.state)
  const maxTurns = params.config?.maxTurns ?? config.maxTurns
  const externalSignal = params.config?.signal
  const usageAtStart = { ...state.usage }
  const infra = initLoopInfra(state, config, externalSignal)
  const props = Object.freeze(params.props ?? {})
  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`

  const runtimeHandle = createRuntimeHandle({
    props,
    runId,
    provider: infra.provider,
    system: config.system,
    tools: infra.toolDefinitions,
    middleware: config.middleware,
    signal: infra.signal,
    checkpointState: checkpoint.runtime,
  })
  const ctx: RunContext = { state, runtime: runtimeHandle.runtime }

  yield { type: 'agent_run_start', runId, messages: state.messages }

  try {
    yield* awaitRuntimeOperation(infra.pipeline.runBeforeAgent(ctx), runtimeHandle)

    for (let index = 0; index < pendingToolCalls.length; index++) {
      const call = pendingToolCalls[index]!
      const decision: ToolCallDecision | undefined = decisions[call.id]
      if (decision?.action === 'deny') {
        state.messages.push(
          new ToolMessage(
            call.id,
            call.name,
            `Error: 用户拒绝执行此操作${decision.reason ? ': ' + decision.reason : ''}`,
          ),
        )
        runtimeHandle.setPendingToolCalls(pendingToolCalls.slice(index + 1))
        continue
      }

      const input = decision?.action === 'modify' ? decision.input : call.input
      runtimeHandle.setPendingToolCalls([
        { id: call.id, name: call.name, input },
        ...pendingToolCalls.slice(index + 1),
      ])
      const output = yield* awaitRuntimeOperation(
        infra.wrappedToolCall(
          createToolCallRequest(ctx, {
            id: call.id,
            name: call.name,
            input,
          }),
        ),
        runtimeHandle,
      )
      state.messages.push(
        new ToolMessage(
          call.id,
          call.name,
          output.isError ? `Error: ${output.content}` : output.content,
        ),
      )
      runtimeHandle.setPendingToolCalls(pendingToolCalls.slice(index + 1))
    }
    runtimeHandle.setPendingToolCalls([])

    runtimeHandle.setTurnIndex(resumeTurnIndex + 1)
    yield* runMainLoop({
      maxTurns,
      pipeline: infra.pipeline,
      wrappedToolCall: infra.wrappedToolCall,
      wrappedModelCall: infra.wrappedModelCall,
      toolMap: infra.toolMap,
      ctx,
      runtimeHandle,
    })
  } catch (err) {
    runtimeHandle.setStopReason(infra.signal.aborted ? 'abort' : 'error')
    throw err
  } finally {
    yield* awaitRuntimeOperation(infra.pipeline.runAfterAgent(ctx), runtimeHandle)
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
    state: serializeAgentState(state),
    stopReason: runtimeHandle.stopReason,
  }
}

export { SuspendSignal, isSuspendSignal, serializeAgentState, deserializeAgentState }
export type { ResumeParams }
