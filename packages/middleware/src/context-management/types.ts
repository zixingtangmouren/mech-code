import type { AgentMessage, Awaitable, LLMProvider, RunContext } from '@mech-code/core'

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

export interface CompactOptions {
  source: ContextSummaryRecord['source']
  keep: KeepStrategy
}

export type ResolvedToolResultBudgetOptions = Required<ToolResultBudgetOptions>
export type ResolvedToolResultCleanupOptions = Required<ToolResultCleanupOptions>
export type ResolvedReactiveCompactOptions = Required<ReactiveCompactOptions>
