import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ProviderError,
  UserMessage,
  createMiddleware,
  estimateMessagesTokens,
  estimateTokens,
  normalizeMessages,
  retryStreamResult,
} from '@mech-code/core'
import type {
  AgentMessage,
  AgentMiddleware,
  AssistantContentBlock,
  Awaitable,
  ChatParams,
  LLMProvider,
  ModelCallHandler,
  ModelCallRequest,
  RunContext,
  StreamResult,
  ToolOutput,
} from '@mech-code/core'

export const CONTEXT_MANAGEMENT_STATE_KEY = 'contextManagement'

export interface ContextManagementMiddlewareOptions {
  provider?: LLMProvider
  summaryProvider?: LLMProvider
  modelContextWindow?: number | ((ctx: RunContext) => number)
  reservedOutputTokens?: number
  tokenCounter?: TokenCounter
  trigger?: ContextTrigger | ContextTrigger[]
  keep?: KeepStrategy
  summary?: SummaryOptions
  toolResults?: ToolResultBudgetOptions
  cleanup?: ToolResultCleanupOptions
  reactiveCompact?: ReactiveCompactOptions
}

export type TokenCounter = (messages: AgentMessage[], ctx: RunContext) => number

export type ContextTrigger = {
  tokens?: number
  messages?: number
  fraction?: number
  toolResultChars?: number
}

export type KeepStrategy = { messages: number } | { tokens: number } | { fraction: number }

export interface SummaryOptions {
  prompt?: string
  prefix?: string
  maxTokens?: number
  temperature?: number
  sources?: SummarySource[]
  sourcePolicy?: 'prefer_fresh_source' | 'always_regenerate' | 'source_then_refine'
}

export interface SummarySource {
  name: string
  load(ctx: RunContext): Awaitable<SummarySourceResult | null>
}

export interface SummarySourceResult {
  content: string
  coveredUntilMessageId?: string
  coveredUntilMessageIndex?: number
  estimatedTokens?: number
  fresh: boolean
  metadata?: Record<string, unknown>
}

export interface ToolResultBudgetOptions {
  maxResultChars?: number
  maxResultTokens?: number
  maxResultsPerMessageChars?: number
  previewChars?: number
  strategy?: 'preview_only' | 'preview_and_store' | 'truncate'
  storage?: ToolResultStorageOptions
}

export type ToolResultStorageOptions = { type: 'state' } | { type: 'file'; dir: string }

export interface ToolResultCleanupOptions {
  enabled?: boolean
  trigger?: {
    idleMinutes?: number
    turns?: number
    tokens?: number
  }
  keepRecentToolResults?: number
  replacementText?: string
}

export interface ReactiveCompactOptions {
  enabled?: boolean
  maxRetries?: number
  fallbackKeep?: KeepStrategy
}

export interface ContextManagementState {
  summaries: ContextSummaryRecord[]
  toolResults: Record<string, StoredToolResultRecord>
  cleanup: {
    lastCleanupAt?: number
    lastCleanupTurn?: number
    clearedToolResultCount?: number
  }
  failures: {
    compactConsecutiveFailures: number
    reactiveCompactConsecutiveFailures: number
    toolStorageConsecutiveFailures: number
  }
}

export interface ContextSummaryRecord {
  id: string
  turnIndex: number
  source: 'auto_compact' | 'reactive_compact' | 'manual_compact'
  summaryMessageId: string
  compressedMessageCount: number
  estimatedInputTokensBefore: number
  estimatedInputTokensAfter: number
  createdAt: number
}

export interface StoredToolResultRecord {
  toolCallId: string
  toolName: string
  originalChars: number
  originalEstimatedTokens: number
  preview: string
  storage?: { type: 'state'; content: string } | { type: 'file'; path: string }
  cleared?: true
  createdAt: number
}

interface VisibleEntry {
  index: number
  message: AgentMessage
}

type ToolVisibleEntry = VisibleEntry & {
  message: Extract<VisibleEntry['message'], { role: 'tool' }>
}

interface CompactOptions {
  source: ContextSummaryRecord['source']
  keep: KeepStrategy
}

const DEFAULT_KEEP: KeepStrategy = { messages: 20 }
const DEFAULT_REACTIVE_KEEP: KeepStrategy = { messages: 8 }
const DEFAULT_TOOL_MAX_CHARS = 50_000
const DEFAULT_TOOL_PREVIEW_CHARS = 8_000
const DEFAULT_TOOL_MAX_BATCH_CHARS = 200_000

export function contextManagementMiddleware(
  options: ContextManagementMiddlewareOptions = {},
): AgentMiddleware {
  const toolResultOptions = resolveToolResultOptions(options.toolResults)
  const cleanupOptions = resolveCleanupOptions(options.cleanup)
  const reactiveOptions = resolveReactiveOptions(options.reactiveCompact)

  return createMiddleware({
    name: 'context-management',
    state: { [CONTEXT_MANAGEMENT_STATE_KEY]: createDefaultState() },
    beforeAgent(ctx) {
      ensureContextManagementState(ctx.state)
    },
    async beforeModel(ctx) {
      ensureContextManagementState(ctx.state)
      applyAggregateToolResultBudget(ctx, toolResultOptions)
      applyToolResultCleanup(ctx, options, cleanupOptions)

      if (shouldCompact(ctx, options)) {
        await compactContext(ctx, options, {
          source: 'auto_compact',
          keep: options.keep ?? DEFAULT_KEEP,
        })
      }
    },
    async wrapToolCall(request, handler) {
      const output = await handler(request)
      return budgetToolOutput(
        request.context,
        request.toolCallId,
        request.toolName,
        output,
        toolResultOptions,
      )
    },
    async wrapModelCall(request, handler) {
      return callModelWithReactiveCompact(request, handler, options, reactiveOptions)
    },
  })
}

function createDefaultState(): ContextManagementState {
  return {
    summaries: [],
    toolResults: {},
    cleanup: {},
    failures: {
      compactConsecutiveFailures: 0,
      reactiveCompactConsecutiveFailures: 0,
      toolStorageConsecutiveFailures: 0,
    },
  }
}

function ensureContextManagementState(state: RunContext['state']): ContextManagementState {
  const existing = state[CONTEXT_MANAGEMENT_STATE_KEY]
  if (isContextManagementState(existing)) return existing

  const created = createDefaultState()
  state[CONTEXT_MANAGEMENT_STATE_KEY] = created
  return created
}

function isContextManagementState(value: unknown): value is ContextManagementState {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return Array.isArray(record.summaries) && typeof record.toolResults === 'object'
}

function resolveToolResultOptions(
  options?: ToolResultBudgetOptions,
): Required<ToolResultBudgetOptions> {
  return {
    maxResultChars: options?.maxResultChars ?? DEFAULT_TOOL_MAX_CHARS,
    maxResultTokens: options?.maxResultTokens ?? Number.POSITIVE_INFINITY,
    maxResultsPerMessageChars: options?.maxResultsPerMessageChars ?? DEFAULT_TOOL_MAX_BATCH_CHARS,
    previewChars: options?.previewChars ?? DEFAULT_TOOL_PREVIEW_CHARS,
    strategy: options?.strategy ?? 'preview_only',
    storage: options?.storage ?? { type: 'state' },
  }
}

function resolveCleanupOptions(
  options?: ToolResultCleanupOptions,
): Required<ToolResultCleanupOptions> {
  return {
    enabled: options?.enabled ?? false,
    trigger: options?.trigger ?? {},
    keepRecentToolResults: options?.keepRecentToolResults ?? 10,
    replacementText:
      options?.replacementText ??
      'Tool result was cleared by context management. The original result is no longer visible.',
  }
}

function resolveReactiveOptions(
  options?: ReactiveCompactOptions,
): Required<ReactiveCompactOptions> {
  return {
    enabled: options?.enabled ?? true,
    maxRetries: options?.maxRetries ?? 1,
    fallbackKeep: options?.fallbackKeep ?? DEFAULT_REACTIVE_KEEP,
  }
}

async function budgetToolOutput(
  ctx: RunContext,
  toolCallId: string,
  toolName: string,
  output: ToolOutput,
  options: Required<ToolResultBudgetOptions>,
): Promise<ToolOutput> {
  const originalEstimatedTokens = estimateTokens(output.content)
  if (
    output.content.length <= options.maxResultChars &&
    originalEstimatedTokens <= options.maxResultTokens
  ) {
    return output
  }

  const record = await createStoredToolResultRecord(
    ctx,
    toolCallId,
    toolName,
    output.content,
    originalEstimatedTokens,
    options,
  )
  const state = ensureContextManagementState(ctx.state)
  state.toolResults[toolCallId] = record

  return {
    ...output,
    content: renderToolPreview(record),
  }
}

async function createStoredToolResultRecord(
  ctx: RunContext,
  toolCallId: string,
  toolName: string,
  content: string,
  originalEstimatedTokens: number,
  options: Required<ToolResultBudgetOptions>,
): Promise<StoredToolResultRecord> {
  const preview = content.slice(0, options.previewChars)
  const record: StoredToolResultRecord = {
    toolCallId,
    toolName,
    originalChars: content.length,
    originalEstimatedTokens,
    preview,
    createdAt: Date.now(),
  }

  if (options.strategy === 'preview_and_store') {
    record.storage = await storeToolResult(ctx, toolCallId, content, options.storage)
  }

  return record
}

async function storeToolResult(
  ctx: RunContext,
  toolCallId: string,
  content: string,
  storage: ToolResultStorageOptions,
): Promise<StoredToolResultRecord['storage']> {
  if (storage.type === 'state') return { type: 'state', content }

  try {
    const runDir = join(storage.dir, ctx.runtime.runId)
    await mkdir(runDir, { recursive: true })
    const path = join(runDir, `${sanitizePathSegment(toolCallId)}.txt`)
    await writeFile(path, content, 'utf8')
    return { type: 'file', path }
  } catch {
    const state = ensureContextManagementState(ctx.state)
    state.failures.toolStorageConsecutiveFailures++
    return { type: 'state', content }
  }
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_')
}

function renderToolPreview(record: StoredToolResultRecord): string {
  const storageLine =
    record.storage?.type === 'file'
      ? `\n\nFull result: ${record.storage.path}`
      : record.storage?.type === 'state'
        ? '\n\nFull result is stored in state.contextManagement.toolResults.'
        : ''

  return [
    'Tool result is large and has been shortened by context management.',
    '',
    `Original chars: ${record.originalChars}`,
    `Estimated tokens: ${record.originalEstimatedTokens}`,
    '',
    'Preview:',
    record.preview,
    storageLine,
  ]
    .filter((line) => line.length > 0)
    .join('\n')
}

function applyAggregateToolResultBudget(
  ctx: RunContext,
  options: Required<ToolResultBudgetOptions>,
): void {
  const toolMessages = getVisibleEntries(ctx.state.messages).filter(isToolEntry)
  const totalChars = toolMessages.reduce((sum, entry) => sum + entry.message.content.length, 0)
  if (totalChars <= options.maxResultsPerMessageChars) return

  let remainingChars = totalChars
  const largestFirst = [...toolMessages].sort(
    (a, b) => b.message.content.length - a.message.content.length,
  )
  for (const entry of largestFirst) {
    if (remainingChars <= options.maxResultsPerMessageChars) break
    if (entry.message.content.length <= options.previewChars) continue

    const record: StoredToolResultRecord = {
      toolCallId: entry.message.toolCallId,
      toolName: 'unknown',
      originalChars: entry.message.content.length,
      originalEstimatedTokens: estimateTokens(entry.message.content),
      preview: entry.message.content.slice(0, options.previewChars),
      createdAt: Date.now(),
    }
    const state = ensureContextManagementState(ctx.state)
    state.toolResults[entry.message.toolCallId] = record
    remainingChars -= entry.message.content.length - renderToolPreview(record).length
    entry.message.content = renderToolPreview(record)
  }
}

function applyToolResultCleanup(
  ctx: RunContext,
  options: ContextManagementMiddlewareOptions,
  cleanup: Required<ToolResultCleanupOptions>,
): void {
  if (!cleanup.enabled) return
  if (!shouldCleanup(ctx, options, cleanup)) return

  const toolMessages = getVisibleEntries(ctx.state.messages).filter(isToolEntry)
  const keepIds = new Set(
    toolMessages
      .slice(Math.max(toolMessages.length - cleanup.keepRecentToolResults, 0))
      .map((entry) => entry.message.toolCallId),
  )
  const state = ensureContextManagementState(ctx.state)
  let cleared = 0

  for (const entry of toolMessages) {
    if (keepIds.has(entry.message.toolCallId)) continue
    if (entry.message.content === cleanup.replacementText) continue
    entry.message.content = cleanup.replacementText
    state.toolResults[entry.message.toolCallId] ??= {
      toolCallId: entry.message.toolCallId,
      toolName: 'unknown',
      originalChars: 0,
      originalEstimatedTokens: 0,
      preview: '',
      createdAt: Date.now(),
    }
    state.toolResults[entry.message.toolCallId]!.cleared = true
    cleared++
  }

  if (cleared > 0) {
    state.cleanup = {
      lastCleanupAt: Date.now(),
      lastCleanupTurn: ctx.loopState.turnIndex,
      clearedToolResultCount: (state.cleanup.clearedToolResultCount ?? 0) + cleared,
    }
    ctx.runtime.notifyStateChanged('context_management_cleanup', [
      'messages',
      CONTEXT_MANAGEMENT_STATE_KEY,
    ])
  }
}

function shouldCleanup(
  ctx: RunContext,
  options: ContextManagementMiddlewareOptions,
  cleanup: Required<ToolResultCleanupOptions>,
): boolean {
  const trigger = cleanup.trigger
  const state = ensureContextManagementState(ctx.state)

  if (
    trigger.turns !== undefined &&
    ctx.loopState.turnIndex - (state.cleanup.lastCleanupTurn ?? -1) >= trigger.turns
  ) {
    return true
  }

  if (trigger.tokens !== undefined) {
    const tokens = countTokens(getVisibleMessages(ctx.state.messages), ctx, options)
    if (tokens >= trigger.tokens) return true
  }

  if (trigger.idleMinutes !== undefined && state.cleanup.lastCleanupAt !== undefined) {
    const elapsedMs = Date.now() - state.cleanup.lastCleanupAt
    if (elapsedMs >= trigger.idleMinutes * 60_000) return true
  }

  return false
}

function shouldCompact(ctx: RunContext, options: ContextManagementMiddlewareOptions): boolean {
  if (!options.trigger) return false
  const triggers = Array.isArray(options.trigger) ? options.trigger : [options.trigger]
  const visibleMessages = getVisibleMessages(ctx.state.messages)
  const tokenCount = countTokens(visibleMessages, ctx, options)
  const toolResultChars = visibleMessages.reduce((sum, message) => {
    return message.role === 'tool' ? sum + message.content.length : sum
  }, 0)

  return triggers.some((trigger) => {
    if (trigger.tokens !== undefined && tokenCount < trigger.tokens) return false
    if (trigger.messages !== undefined && visibleMessages.length < trigger.messages) return false
    if (trigger.toolResultChars !== undefined && toolResultChars < trigger.toolResultChars) {
      return false
    }
    if (trigger.fraction !== undefined) {
      const window = resolveContextWindow(ctx, options)
      if (window === undefined) return false
      const reserved = options.reservedOutputTokens ?? Math.min(window, 20_000)
      const usableWindow = Math.max(window - reserved, 0)
      if (tokenCount < usableWindow * trigger.fraction) return false
    }
    return true
  })
}

async function compactContext(
  ctx: RunContext,
  options: ContextManagementMiddlewareOptions,
  compact: CompactOptions,
): Promise<boolean> {
  const state = ensureContextManagementState(ctx.state)
  const entries = getVisibleEntries(ctx.state.messages)
  const cutoff = adjustCutoffForToolGroups(
    entries,
    computeCutoff(entries, ctx, options, compact.keep),
  )
  if (cutoff <= 0) return false

  const entriesToSummarize = entries.slice(0, cutoff)
  const estimatedBefore = countTokens(
    entries.map((entry) => entry.message),
    ctx,
    options,
  )

  let summaryText: string
  try {
    summaryText = await buildSummary(
      ctx,
      options,
      entriesToSummarize.map((entry) => entry.message),
    )
    state.failures.compactConsecutiveFailures = 0
  } catch {
    state.failures.compactConsecutiveFailures++
    if (compact.source === 'reactive_compact') state.failures.reactiveCompactConsecutiveFailures++
    return false
  }

  const summaryId = `summary_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const summaryMessage = new UserMessage(
    `${options.summary?.prefix ?? 'Context summary:'}\n\n${summaryText}`,
    {
      metadata: {
        source: 'agent',
        injected: true,
        kind: 'context_summary',
        contextManagement: { summaryId },
      },
    },
  )

  for (const entry of entriesToSummarize) {
    entry.message.metadata.contextManagement = {
      ...readContextManagementMetadata(entry.message.metadata),
      compressed: true,
      summaryId,
    }
    ctx.state.messages[entry.index] = entry.message
  }

  const insertIndex = entries[cutoff]?.index ?? ctx.state.messages.length
  ctx.state.messages.splice(insertIndex, 0, summaryMessage)

  const estimatedAfter = countTokens(getVisibleMessages(ctx.state.messages), ctx, options)
  state.summaries.push({
    id: summaryId,
    turnIndex: ctx.loopState.turnIndex,
    source: compact.source,
    summaryMessageId: summaryId,
    compressedMessageCount: entriesToSummarize.length,
    estimatedInputTokensBefore: estimatedBefore,
    estimatedInputTokensAfter: estimatedAfter,
    createdAt: Date.now(),
  })
  ctx.runtime.notifyStateChanged('context_management_compact', [
    'messages',
    CONTEXT_MANAGEMENT_STATE_KEY,
  ])
  return true
}

function computeCutoff(
  entries: VisibleEntry[],
  ctx: RunContext,
  options: ContextManagementMiddlewareOptions,
  keep: KeepStrategy,
): number {
  if ('messages' in keep) return Math.max(entries.length - keep.messages, 0)

  if ('tokens' in keep) {
    return computeTokenCutoff(entries, ctx, options, keep.tokens)
  }

  const window = resolveContextWindow(ctx, options)
  if (window === undefined) return Math.max(entries.length - 20, 0)
  return computeTokenCutoff(entries, ctx, options, Math.floor(window * keep.fraction))
}

function computeTokenCutoff(
  entries: VisibleEntry[],
  ctx: RunContext,
  options: ContextManagementMiddlewareOptions,
  keepTokens: number,
): number {
  let tokens = 0
  for (let index = entries.length - 1; index >= 0; index--) {
    const nextTokens = countTokens([entries[index]!.message], ctx, options)
    if (tokens + nextTokens > keepTokens) return index + 1
    tokens += nextTokens
  }
  return 0
}

function adjustCutoffForToolGroups(entries: VisibleEntry[], initialCutoff: number): number {
  let cutoff = initialCutoff
  let changed = true

  while (changed) {
    changed = false
    const preserved = entries.slice(cutoff)
    const compressed = entries.slice(0, cutoff)
    const preservedToolIds = new Set(
      preserved
        .filter((entry) => entry.message.role === 'tool')
        .map((entry) => (entry.message.role === 'tool' ? entry.message.toolCallId : '')),
    )

    for (let index = compressed.length - 1; index >= 0; index--) {
      const message = compressed[index]!.message
      if (message.role !== 'assistant') continue
      const toolUseIds = getToolUseIds(message.content)
      if (toolUseIds.some((id) => preservedToolIds.has(id))) {
        cutoff = index
        changed = true
        break
      }
    }

    const firstPreserved = entries[cutoff]?.message
    if (!changed && firstPreserved?.role === 'tool') {
      const assistantIndex = findAssistantToolUseBefore(entries, cutoff, firstPreserved.toolCallId)
      if (assistantIndex >= 0 && assistantIndex < cutoff) {
        cutoff = assistantIndex
        changed = true
      }
    }
  }

  return cutoff
}

function getToolUseIds(content: string | AssistantContentBlock[]): string[] {
  if (!Array.isArray(content)) return []
  return content.flatMap((block) => (block.type === 'tool_use' ? [block.id] : []))
}

function findAssistantToolUseBefore(
  entries: VisibleEntry[],
  cutoff: number,
  toolCallId: string,
): number {
  for (let index = cutoff - 1; index >= 0; index--) {
    const message = entries[index]!.message
    if (message.role !== 'assistant') continue
    if (getToolUseIds(message.content).includes(toolCallId)) return index
  }
  return -1
}

async function buildSummary(
  ctx: RunContext,
  options: ContextManagementMiddlewareOptions,
  messages: AgentMessage[],
): Promise<string> {
  const sourcePolicy = options.summary?.sourcePolicy ?? 'prefer_fresh_source'
  const source = await loadFreshSummarySource(ctx, options.summary?.sources ?? [])

  if (source && sourcePolicy === 'prefer_fresh_source') return source.content

  const provider = options.summaryProvider ?? options.provider ?? ctx.runtime.provider
  const prompt = buildSummaryPrompt(options, messages, source)
  const response = await provider.chat(
    {
      messages: normalizeMessages([new UserMessage(prompt)]),
    },
    {
      signal: ctx.runtime.signal,
      modelParams: {
        maxTokens: options.summary?.maxTokens,
        temperature: options.summary?.temperature,
      },
    },
  )
  return assistantText(response.content)
}

async function loadFreshSummarySource(
  ctx: RunContext,
  sources: SummarySource[],
): Promise<SummarySourceResult | null> {
  for (const source of sources) {
    const result = await source.load(ctx)
    if (result?.fresh) return result
  }
  return null
}

function buildSummaryPrompt(
  options: ContextManagementMiddlewareOptions,
  messages: AgentMessage[],
  source: SummarySourceResult | null,
): string {
  const prompt =
    options.summary?.prompt ??
    'Summarize the conversation history for future context. Preserve user goals, decisions, tool results, constraints, and unresolved work.'
  const sourceText = source ? `\n\nExisting session note:\n${source.content}` : ''
  return `${prompt}${sourceText}\n\nConversation to summarize:\n${renderTranscript(messages)}`
}

function renderTranscript(messages: AgentMessage[]): string {
  return messages
    .map((message) => {
      if (message.role === 'tool') {
        return `[tool:${message.toolCallId}]\n${message.content}`
      }
      return `[${message.role}]\n${renderMessageContent(message.content)}`
    })
    .join('\n\n')
}

function renderMessageContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (!isRecord(block)) return JSON.stringify(block)
      if (typeof block.text === 'string') return block.text
      if (block.type === 'tool_use') {
        const name = typeof block.name === 'string' ? block.name : 'unknown'
        const input = 'input' in block ? block.input : {}
        return `[tool_use:${name}] ${JSON.stringify(input)}`
      }
      return JSON.stringify(block)
    })
    .join('\n')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assistantText(content: AssistantContentBlock[]): string {
  return content
    .filter(
      (block): block is Extract<AssistantContentBlock, { type: 'text' }> => block.type === 'text',
    )
    .map((block) => block.text)
    .join('')
    .trim()
}

async function callModelWithReactiveCompact(
  request: ModelCallRequest,
  handler: ModelCallHandler,
  options: ContextManagementMiddlewareOptions,
  reactive: Required<ReactiveCompactOptions>,
): Promise<StreamResult> {
  let attempts = 0

  const retry = async (error: unknown): Promise<StreamResult | null> => {
    if (!shouldReactiveCompact(error, reactive, attempts)) return null
    attempts++
    const compacted = await compactContext(request.context, options, {
      source: 'reactive_compact',
      keep: reactive.fallbackKeep,
    })
    if (!compacted) return null
    return handler(withVisibleMessages(request))
  }

  try {
    const result = await handler(withVisibleMessages(request))
    return retryStreamResult(result, ({ error }) => retry(error))
  } catch (error) {
    const retryResult = await retry(error)
    if (!retryResult) throw error
    return retryStreamResult(retryResult, ({ error: retryError }) => retry(retryError))
  }
}

function shouldReactiveCompact(
  error: unknown,
  reactive: Required<ReactiveCompactOptions>,
  attempts: number,
): boolean {
  return (
    reactive.enabled &&
    attempts < reactive.maxRetries &&
    error instanceof ProviderError &&
    error.code === 'context_too_long'
  )
}

function withVisibleMessages(request: ModelCallRequest): ModelCallRequest {
  return {
    ...request,
    params: {
      ...request.params,
      messages: normalizeMessages(getVisibleMessages(request.context.state.messages)),
    } satisfies ChatParams,
  }
}

function getVisibleMessages(messages: AgentMessage[]): AgentMessage[] {
  return getVisibleEntries(messages).map((entry) => entry.message)
}

function getVisibleEntries(messages: AgentMessage[]): VisibleEntry[] {
  const result: VisibleEntry[] = []
  for (const [index, message] of messages.entries()) {
    if (!isContextCompressed(message.metadata)) {
      result.push({ index, message })
    }
  }
  return result
}

function isToolEntry(entry: VisibleEntry): entry is ToolVisibleEntry {
  return entry.message.role === 'tool'
}

function isContextCompressed(metadata: Record<string, unknown>): boolean {
  return readContextManagementMetadata(metadata).compressed === true
}

function readContextManagementMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const value = metadata.contextManagement
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function countTokens(
  messages: AgentMessage[],
  ctx: RunContext,
  options: ContextManagementMiddlewareOptions,
): number {
  return options.tokenCounter
    ? options.tokenCounter(messages, ctx)
    : estimateMessagesTokens(normalizeMessages(messages))
}

function resolveContextWindow(
  ctx: RunContext,
  options: ContextManagementMiddlewareOptions,
): number | undefined {
  if (typeof options.modelContextWindow === 'function') return options.modelContextWindow(ctx)
  return options.modelContextWindow
}
