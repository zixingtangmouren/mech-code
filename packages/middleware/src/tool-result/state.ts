import type { RunContext } from '@mech-code/core'
import { TOOL_RESULT_STATE_KEY, type ToolResultState } from './types.js'

export function createToolResultState(): ToolResultState {
  return {
    records: {},
    cleanup: {},
  }
}

export function ensureToolResultState(state: RunContext['state']): ToolResultState {
  const existing = state[TOOL_RESULT_STATE_KEY]
  if (isToolResultState(existing)) return existing

  const created = createToolResultState()
  state[TOOL_RESULT_STATE_KEY] = created
  return created
}

export function getToolResultState(state: RunContext['state']): ToolResultState {
  const existing = state[TOOL_RESULT_STATE_KEY]
  if (isToolResultState(existing)) return existing
  throw new Error('toolResult state is not initialized')
}

function isToolResultState(value: unknown): value is ToolResultState {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.records === 'object' && typeof record.cleanup === 'object'
}
