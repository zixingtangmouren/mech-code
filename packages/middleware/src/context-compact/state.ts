import type { RunContext } from '@mech-code/core'
import { CONTEXT_COMPACT_STATE_KEY, type ContextCompactState } from './types.js'

export function createContextCompactState(): ContextCompactState {
  return { summaries: [] }
}

export function ensureContextCompactState(state: RunContext['state']): ContextCompactState {
  const existing = state[CONTEXT_COMPACT_STATE_KEY]
  if (isContextCompactState(existing)) return existing

  const created = createContextCompactState()
  state[CONTEXT_COMPACT_STATE_KEY] = created
  return created
}

export function getContextCompactState(state: RunContext['state']): ContextCompactState {
  const existing = state[CONTEXT_COMPACT_STATE_KEY]
  if (isContextCompactState(existing)) return existing
  throw new Error('contextCompact state is not initialized')
}

function isContextCompactState(value: unknown): value is ContextCompactState {
  if (!value || typeof value !== 'object') return false
  return Array.isArray((value as Record<string, unknown>).summaries)
}
