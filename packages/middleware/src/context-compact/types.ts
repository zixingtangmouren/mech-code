import type {
  AgentEvent,
  AgentMessage,
  Awaitable,
  CustomAgentEvent,
  LLMProvider,
  RunContext,
} from '@mech-code/core'

export const CONTEXT_COMPACT_STATE_KEY = 'contextCompact'
export const CONTEXT_COMPACT_EVENT_SOURCE = 'context-compact'

export interface ContextCompactMiddlewareOptions {
  summaryProvider?: LLMProvider
  modelContextWindow?: number | ((ctx: RunContext) => number)
  tokenCounter?: TokenCounter
  trigger?: ContextTrigger | ContextTrigger[]
  summary?: SummaryOptions
  reactiveCompact?: ReactiveCompactOptions
}

export type TokenCounter = (messages: AgentMessage[], ctx: RunContext) => number

export type ContextTrigger = {
  tokens?: number
  messages?: number
  fraction?: number
}

export interface SummaryOptions {
  prompt?: string
  prefix?: string
  maxTokens?: number
  temperature?: number
  sources?: SummarySource[]
  sourcePolicy?: 'prefer_fresh_source' | 'always_regenerate'
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

export interface ReactiveCompactOptions {
  enabled?: boolean
  maxRetries?: number
}

export interface ContextCompactState {
  summaries: ContextSummaryRecord[]
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

export interface CompactOptions {
  source: ContextSummaryRecord['source']
}

export type ResolvedReactiveCompactOptions = Required<ReactiveCompactOptions>

export type ContextCompactMode = 'proactive' | 'reactive' | 'manual'

export type ContextCompactStartedEvent = CustomAgentEvent<{ mode: ContextCompactMode }> & {
  source: typeof CONTEXT_COMPACT_EVENT_SOURCE
  name: 'started'
}

export type ContextCompactCompletedEvent = CustomAgentEvent<{
  mode: ContextCompactMode
  summaryId: string
  compressedMessageCount: number
  estimatedInputTokensBefore: number
  estimatedInputTokensAfter: number
}> & {
  source: typeof CONTEXT_COMPACT_EVENT_SOURCE
  name: 'completed'
}

export type ContextCompactFailedEvent = CustomAgentEvent<{
  mode: ContextCompactMode
  error: string
}> & {
  source: typeof CONTEXT_COMPACT_EVENT_SOURCE
  name: 'failed'
}

export type ContextCompactEvent =
  | ContextCompactStartedEvent
  | ContextCompactCompletedEvent
  | ContextCompactFailedEvent

export function isContextCompactEvent(event: AgentEvent): event is ContextCompactEvent {
  if (event.type !== 'custom' || event.source !== CONTEXT_COMPACT_EVENT_SOURCE) return false
  if (event.name !== 'started' && event.name !== 'completed' && event.name !== 'failed')
    return false
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload))
    return false
  if (!isContextCompactMode(event.payload.mode)) return false
  if (event.name === 'started') return true
  if (event.name === 'failed') return typeof event.payload.error === 'string'
  return (
    typeof event.payload.summaryId === 'string' &&
    typeof event.payload.compressedMessageCount === 'number' &&
    typeof event.payload.estimatedInputTokensBefore === 'number' &&
    typeof event.payload.estimatedInputTokensAfter === 'number'
  )
}

function isContextCompactMode(value: unknown): value is ContextCompactMode {
  return value === 'proactive' || value === 'reactive' || value === 'manual'
}
