export const TOOL_RESULT_STATE_KEY = 'toolResult'

export interface ToolResultMiddlewareOptions extends ToolResultBudgetOptions {
  cleanup?: ToolResultCleanupOptions
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
  maxAgeMs?: number
  replacementText?: string
}

export interface ToolResultState {
  records: Record<string, StoredToolResultRecord>
  cleanup: {
    lastCleanupAt?: number
    clearedToolResultCount?: number
  }
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

export type ResolvedToolResultBudgetOptions = Required<ToolResultBudgetOptions>
export type ResolvedToolResultCleanupOptions = ToolResultCleanupOptions & {
  replacementText: string
}
