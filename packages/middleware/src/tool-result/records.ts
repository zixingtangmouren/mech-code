import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { estimateTokens } from '@mech-code/core'
import type { RunContext, ToolOutput } from '@mech-code/core'
import { getToolResultState } from './state.js'
import {
  type ResolvedToolResultBudgetOptions,
  type StoredToolResultRecord,
  type ToolResultState,
  type ToolResultStorageOptions,
} from './types.js'
import { getToolMessages } from './visibility.js'

/**
 * 记录大型返回结果的工具内容
 * @param ctx
 * @param toolCallId
 * @param toolName
 * @param output
 * @param options
 * @returns
 */
export async function recordToolOutputBudget(
  ctx: RunContext,
  toolCallId: string,
  toolName: string,
  output: ToolOutput,
  options: ResolvedToolResultBudgetOptions,
): Promise<ToolOutput> {
  const content = output.isError ? `Error: ${output.content}` : output.content
  const estimatedTokens = estimateTokens(content)
  if (!shouldBudgetToolContent(content, estimatedTokens, options)) return output

  const state = getToolResultState(ctx.state)
  state.records[toolCallId] = await createStoredToolResultRecord(
    ctx,
    toolCallId,
    toolName,
    content,
    estimatedTokens,
    options,
  )
  return output
}

/**
 * 记录未管理的工具消息预算
 * 这适用于在模型调用之前已经存在的工具消息，确保它们也被考虑在内。
 * @param ctx
 * @param state
 * @param options
 */
export async function recordUnmanagedToolMessageBudgets(
  ctx: RunContext,
  state: ToolResultState,
  options: ResolvedToolResultBudgetOptions,
): Promise<void> {
  for (const message of getToolMessages(ctx.state.messages)) {
    if (state.records[message.toolCallId]) continue

    const estimatedTokens = estimateTokens(message.content)
    if (!shouldBudgetToolContent(message.content, estimatedTokens, options)) continue

    state.records[message.toolCallId] = await createStoredToolResultRecord(
      ctx,
      message.toolCallId,
      message.toolName,
      message.content,
      estimatedTokens,
      options,
    )
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
  toolCallId: string,
  toolName: string,
  content: string,
  originalEstimatedTokens: number,
  options: ResolvedToolResultBudgetOptions,
): Promise<StoredToolResultRecord> {
  const record: StoredToolResultRecord = {
    toolCallId,
    toolName,
    originalChars: content.length,
    originalEstimatedTokens,
    preview: content.slice(0, options.previewChars),
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
        ? '\n\nFull result is stored in state.toolResult.records.'
        : ''

  return [
    'Tool result is large and has been shortened by tool result middleware.',
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
