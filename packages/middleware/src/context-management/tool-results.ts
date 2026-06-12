import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { estimateTokens } from '@mech-code/core'
import type { RunContext, ToolOutput } from '@mech-code/core'
import { getContextManagementState } from './state.js'
import {
  type ContextManagementState,
  type ResolvedToolResultBudgetOptions,
  type StoredToolResultRecord,
  type ToolResultStorageOptions,
} from './types.js'
import { getVisibleEntries, isToolEntry } from './visibility.js'

export async function recordToolOutputBudget(
  ctx: RunContext,
  toolCallId: string,
  toolName: string,
  output: ToolOutput,
  options: ResolvedToolResultBudgetOptions,
): Promise<ToolOutput> {
  const messageContent = output.isError ? `Error: ${output.content}` : output.content
  const originalEstimatedTokens = estimateTokens(messageContent)
  if (!shouldBudgetToolContent(messageContent, originalEstimatedTokens, options)) {
    return output
  }

  const state = getContextManagementState(ctx.state)
  const record = await createStoredToolResultRecord(
    ctx,
    state,
    toolCallId,
    toolName,
    messageContent,
    originalEstimatedTokens,
    options,
  )
  state.toolResults[toolCallId] = record

  return output
}

export async function recordUnmanagedToolMessageBudgets(
  ctx: RunContext,
  state: ContextManagementState,
  options: ResolvedToolResultBudgetOptions,
): Promise<void> {
  const unmanagedToolMessages = getVisibleEntries(ctx.state.messages)
    .filter(isToolEntry)
    .filter((entry) => state.toolResults[entry.message.toolCallId] === undefined)

  for (const entry of unmanagedToolMessages) {
    const originalEstimatedTokens = estimateTokens(entry.message.content)
    if (!shouldBudgetToolContent(entry.message.content, originalEstimatedTokens, options)) {
      continue
    }

    const record = await createStoredToolResultRecord(
      ctx,
      state,
      entry.message.toolCallId,
      entry.message.toolName,
      entry.message.content,
      originalEstimatedTokens,
      options,
    )
    state.toolResults[entry.message.toolCallId] = record
  }
}

function shouldBudgetToolContent(
  content: string,
  estimatedTokens: number,
  options: ResolvedToolResultBudgetOptions,
): boolean {
  return content.length > options.maxResultChars || estimatedTokens > options.maxResultTokens
}

async function createStoredToolResultRecord(
  ctx: RunContext,
  state: ContextManagementState,
  toolCallId: string,
  toolName: string,
  content: string,
  originalEstimatedTokens: number,
  options: ResolvedToolResultBudgetOptions,
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
    record.storage = await storeToolResult(ctx, state, toolCallId, content, options.storage)
  }

  return record
}

async function storeToolResult(
  ctx: RunContext,
  state: ContextManagementState,
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
    state.failures.toolStorageConsecutiveFailures++
    return { type: 'state', content }
  }
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_')
}

export function renderToolPreview(record: StoredToolResultRecord): string {
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
