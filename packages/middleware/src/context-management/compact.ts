import { UserMessage } from '@mech-code/core'
import type { AgentMessage, AssistantContentBlock, RunContext } from '@mech-code/core'
import { projectToolResultMessages } from './projection.js'
import { getContextManagementState } from './state.js'
import { countTokens, resolveContextWindow } from './tokens.js'
import {
  CONTEXT_MANAGEMENT_STATE_KEY,
  type CompactOptions,
  type ContextManagementState,
  type ContextManagementMiddlewareOptions,
  type KeepStrategy,
  type ResolvedToolResultCleanupOptions,
  type SummarySource,
  type SummarySourceResult,
} from './types.js'
import {
  getToolUseIds,
  getVisibleEntries,
  getVisibleMessages,
  readContextManagementMetadata,
  type VisibleEntry,
} from './visibility.js'

const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use any tool.
- You already have all the context you need in the conversation above.
- Tool calls will be rejected and will waste your only turn.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`

const BASE_COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and the assistant's previous actions.

This summary should be thorough in capturing technical details, code patterns, architectural decisions, errors, fixes, and unresolved work that would be essential for continuing development without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts. In your analysis process:

1. Chronologically analyze each message and section of the conversation.
2. Identify the user's explicit requests and intents, the assistant's approach, key decisions, technical concepts, code patterns, files, function signatures, exact errors, fixes, and user feedback.
3. Double-check technical accuracy and completeness.

Your final summary must be wrapped in <summary> tags and include these sections:

1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections
4. Errors and Fixes
5. Problem Solving
6. All User Messages
7. Pending Tasks
8. Current Work
9. Optional Next Step

Summarize only the conversation messages that appear before this compact instruction. Do not include this compact instruction itself as a user message.`

const NO_TOOLS_TRAILER = `REMINDER: Do NOT call any tools. Respond with plain text only: an <analysis> block followed by a <summary> block.`

export function shouldCompact(
  ctx: RunContext,
  options: ContextManagementMiddlewareOptions,
  state: ContextManagementState,
  cleanup: ResolvedToolResultCleanupOptions,
): boolean {
  if (!options.trigger) return false
  const triggers = Array.isArray(options.trigger) ? options.trigger : [options.trigger]
  const visibleMessages = projectToolResultMessages(
    getVisibleMessages(ctx.state.messages),
    state,
    cleanup,
  )
  const tokenCount = countTokens(visibleMessages, ctx, options)

  return triggers.some((trigger) => {
    if (trigger.tokens !== undefined && tokenCount < trigger.tokens) return false
    if (trigger.messages !== undefined && visibleMessages.length < trigger.messages) return false
    if (trigger.fraction !== undefined) {
      const window = resolveContextWindow(ctx, options)
      if (window === undefined) return false
      const reserved = options.reservedOutputTokens ?? defaultReservedOutputTokens(window)
      const usableWindow = Math.max(window - reserved, 0)
      if (tokenCount < usableWindow * trigger.fraction) return false
    }
    return true
  })
}

function defaultReservedOutputTokens(window: number): number {
  return Math.min(Math.floor(window * 0.2), 20_000)
}

export async function compactContext(
  ctx: RunContext,
  options: ContextManagementMiddlewareOptions,
  compact: CompactOptions,
  cleanup: ResolvedToolResultCleanupOptions,
): Promise<boolean> {
  const state = getContextManagementState(ctx.state)
  const entries = getVisibleEntries(ctx.state.messages)
  const cutoff = adjustCutoffForToolGroups(
    entries,
    computeCutoff(entries, ctx, options, compact.keep, state, cleanup),
  )
  if (cutoff <= 0) return false

  const entriesToSummarize = entries.slice(0, cutoff)
  const estimatedBefore = countTokens(
    projectToolResultMessages(
      entries.map((entry) => entry.message),
      state,
      cleanup,
    ),
    ctx,
    options,
  )

  let summaryText: string
  try {
    summaryText = await buildSummary(
      ctx,
      options,
      projectToolResultMessages(
        entriesToSummarize.map((entry) => entry.message),
        state,
        cleanup,
      ),
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

  const estimatedAfter = countTokens(
    projectToolResultMessages(getVisibleMessages(ctx.state.messages), state, cleanup),
    ctx,
    options,
  )
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
  state: ContextManagementState,
  cleanup: ResolvedToolResultCleanupOptions,
): number {
  if ('messages' in keep) return Math.max(entries.length - keep.messages, 0)

  if ('tokens' in keep) {
    return computeTokenCutoff(entries, ctx, options, keep.tokens, state, cleanup)
  }

  const window = resolveContextWindow(ctx, options)
  if (window === undefined) return Math.max(entries.length - 20, 0)
  return computeTokenCutoff(
    entries,
    ctx,
    options,
    Math.floor(window * keep.fraction),
    state,
    cleanup,
  )
}

function computeTokenCutoff(
  entries: VisibleEntry[],
  ctx: RunContext,
  options: ContextManagementMiddlewareOptions,
  keepTokens: number,
  state: ContextManagementState,
  cleanup: ResolvedToolResultCleanupOptions,
): number {
  let tokens = 0
  for (let index = entries.length - 1; index >= 0; index--) {
    const nextTokens = countTokens(
      projectToolResultMessages([entries[index]!.message], state, cleanup),
      ctx,
      options,
    )
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
  const prompt = buildSummaryPrompt(options, source)
  const response = await provider.chat(
    {
      messages: [...messages, new UserMessage(prompt)],
      system: ctx.runtime.system || undefined,
    },
    {
      signal: ctx.runtime.signal,
      modelParams: {
        maxTokens: options.summary?.maxTokens,
        temperature: options.summary?.temperature,
      },
    },
  )
  const summary = formatCompactSummary(assistantText(response.content))
  if (!summary) throw new Error('Compact summary provider returned no text summary')
  return summary
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
  source: SummarySourceResult | null,
): string {
  const parts = [NO_TOOLS_PREAMBLE + BASE_COMPACT_PROMPT]
  if (source) {
    parts.push(`Existing session note to incorporate or refine:\n${source.content}`)
  }
  const customInstructions = options.summary?.prompt?.trim()
  if (customInstructions) {
    parts.push(`Additional compact instructions:\n${customInstructions}`)
  }
  parts.push(NO_TOOLS_TRAILER)
  return parts.join('\n\n')
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

function formatCompactSummary(summary: string): string {
  let formatted = summary.replace(/<analysis>[\s\S]*?<\/analysis>/i, '')
  const summaryMatch = formatted.match(/<summary>([\s\S]*?)<\/summary>/i)

  if (summaryMatch) {
    formatted = `Summary:\n${summaryMatch[1]?.trim() ?? ''}`
  }

  return formatted.replace(/\n\n+/g, '\n\n').trim()
}
