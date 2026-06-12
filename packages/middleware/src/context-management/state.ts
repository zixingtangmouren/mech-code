import type { RunContext } from '@mech-code/core'
import { CONTEXT_MANAGEMENT_STATE_KEY, type ContextManagementState } from './types.js'

export function createDefaultState(): ContextManagementState {
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

export function ensureContextManagementState(state: RunContext['state']): ContextManagementState {
  const existing = state[CONTEXT_MANAGEMENT_STATE_KEY]
  if (isContextManagementState(existing)) return existing

  const created = createDefaultState()
  state[CONTEXT_MANAGEMENT_STATE_KEY] = created
  return created
}

export function getContextManagementState(state: RunContext['state']): ContextManagementState {
  const existing = state[CONTEXT_MANAGEMENT_STATE_KEY]
  if (isContextManagementState(existing)) return existing
  throw new Error('contextManagement state is not initialized')
}

function isContextManagementState(value: unknown): value is ContextManagementState {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return Array.isArray(record.summaries) && typeof record.toolResults === 'object'
}
