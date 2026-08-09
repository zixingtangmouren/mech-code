import { UserMessage } from '@mech-code/core'
import type { AgentMessage, AssistantContentBlock, RunContext } from '@mech-code/core'
import { getContextCompactState } from './state.js'
import { countTokens, resolveContextWindow } from './tokens.js'
import {
  CONTEXT_COMPACT_EVENT_SOURCE,
  type CompactOptions,
  type ContextCompactMode,
  type ContextCompactMiddlewareOptions,
  type SummarySource,
  type SummarySourceResult,
} from './types.js'
import { getVisibleEntries, getVisibleMessages, readContextCompactMetadata } from './visibility.js'

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
  messages: AgentMessage[],
  options: ContextCompactMiddlewareOptions,
): boolean {
  if (!options.trigger) return false
  const triggers = Array.isArray(options.trigger) ? options.trigger : [options.trigger]
  const visibleMessages = getVisibleMessages(messages)
  const tokenCount = countTokens(visibleMessages, ctx, options)

  return triggers.some((trigger) => {
    if (trigger.tokens !== undefined && tokenCount < trigger.tokens) return false
    if (trigger.messages !== undefined && visibleMessages.length < trigger.messages) return false
    if (trigger.fraction !== undefined) {
      const window = resolveContextWindow(ctx, options)
      if (window === undefined) return false
      if (tokenCount < window * trigger.fraction) return false
    }
    return true
  })
}

export async function compactContext(
  ctx: RunContext,
  messages: AgentMessage[],
  options: ContextCompactMiddlewareOptions,
  compact: CompactOptions,
): Promise<boolean> {
  const state = getContextCompactState(ctx.state)
  const stateEntries = getVisibleEntries(ctx.state.messages)
  const messagesToSummarize = getVisibleMessages(messages)
  if (stateEntries.length === 0 || messagesToSummarize.length === 0) return false

  const estimatedBefore = countTokens(messagesToSummarize, ctx, options)
  const mode = getCompactMode(compact.source)
  ctx.runtime.emitCustomAgentEvent({
    source: CONTEXT_COMPACT_EVENT_SOURCE,
    name: 'started',
    payload: { mode },
  })
  let summaryText: string
  try {
    summaryText = await buildSummary(ctx, options, messagesToSummarize)
  } catch (error) {
    emitCompactFailed(ctx, mode, error)
    return false
  }

  try {
    const summaryId = `summary_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const summaryMessage = new UserMessage(
      `${options.summary?.prefix ?? 'Context summary:'}\n\n${summaryText}`,
      {
        metadata: {
          source: 'agent',
          injected: true,
          kind: 'context_summary',
          contextCompact: { summaryId },
        },
      },
    )

    for (const entry of stateEntries) {
      entry.message.metadata.contextCompact = {
        ...readContextCompactMetadata(entry.message.metadata),
        compressed: true,
        summaryId,
      }
      ctx.state.messages[entry.index] = entry.message
    }
    ctx.state.messages.push(summaryMessage)

    const estimatedAfter = countTokens(getVisibleMessages(ctx.state.messages), ctx, options)
    const summaryRecord = {
      id: summaryId,
      turnIndex: ctx.runtime.turnIndex,
      source: compact.source,
      summaryMessageId: summaryId,
      compressedMessageCount: stateEntries.length,
      estimatedInputTokensBefore: estimatedBefore,
      estimatedInputTokensAfter: estimatedAfter,
      createdAt: Date.now(),
    }
    state.summaries.push(summaryRecord)
    ctx.runtime.emitCustomAgentEvent({
      source: CONTEXT_COMPACT_EVENT_SOURCE,
      name: 'completed',
      payload: {
        mode,
        summaryId,
        compressedMessageCount: summaryRecord.compressedMessageCount,
        estimatedInputTokensBefore: estimatedBefore,
        estimatedInputTokensAfter: estimatedAfter,
      },
    })
    return true
  } catch (error) {
    emitCompactFailed(ctx, mode, error)
    throw error
  }
}

function getCompactMode(source: CompactOptions['source']): ContextCompactMode {
  if (source === 'auto_compact') return 'proactive'
  if (source === 'reactive_compact') return 'reactive'
  return 'manual'
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function emitCompactFailed(ctx: RunContext, mode: ContextCompactMode, error: unknown): void {
  ctx.runtime.emitCustomAgentEvent({
    source: CONTEXT_COMPACT_EVENT_SOURCE,
    name: 'failed',
    payload: { mode, error: getErrorMessage(error) },
  })
}

async function buildSummary(
  ctx: RunContext,
  options: ContextCompactMiddlewareOptions,
  messages: AgentMessage[],
): Promise<string> {
  const sourcePolicy = options.summary?.sourcePolicy ?? 'prefer_fresh_source'
  const source = await loadFreshSummarySource(ctx, options.summary?.sources ?? [])

  if (source && sourcePolicy === 'prefer_fresh_source') return source.content

  const provider = options.summaryProvider ?? ctx.runtime.provider
  const prompt = buildSummaryPrompt(options)
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
  const summary = formatCompactSummary(assistantText(response.message))
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

function buildSummaryPrompt(options: ContextCompactMiddlewareOptions): string {
  const parts = [NO_TOOLS_PREAMBLE + BASE_COMPACT_PROMPT]
  const customInstructions = options.summary?.prompt?.trim()
  if (customInstructions) {
    parts.push(`Additional compact instructions:\n${customInstructions}`)
  }
  parts.push(NO_TOOLS_TRAILER)
  return parts.join('\n\n')
}

function assistantText(message: Extract<AgentMessage, { role: 'assistant' }>): string {
  return message.content
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
