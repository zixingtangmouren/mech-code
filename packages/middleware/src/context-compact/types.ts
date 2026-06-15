import type { AgentMessage, Awaitable, LLMProvider, RunContext } from '@mech-code/core'

export const CONTEXT_COMPACT_STATE_KEY = 'contextCompact'

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
