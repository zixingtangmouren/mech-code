import type { AgentEvent, Usage } from '@mech-code/shared'
import type { StreamMeta, StreamNormalizer } from '../types.js'

// === OpenAI Responses 非流式响应类型 ===

export interface OpenAIResponsesNonStreamResponse {
  output?: OpenAIResponsesOutputItem[]
  usage?: {
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
  }
  status?: string
  incomplete_details?: { reason?: string | null } | null
}

export type OpenAIResponsesOutputItem =
  | {
      type: 'message'
      role?: 'assistant'
      content?: Array<{ type: 'output_text'; text: string } | { type: 'text'; text: string }>
    }
  | {
      type: 'reasoning'
      summary?: Array<{ type: 'summary_text'; text: string }>
      content?: Array<{ type: 'reasoning_text'; text: string }>
    }
  | {
      type: 'function_call'
      id?: string
      call_id?: string
      name?: string
      arguments?: string
    }

export type OpenAIResponsesStreamEvent =
  | { type: 'response.output_text.delta'; delta: string }
  | { type: 'response.reasoning_summary_text.delta'; delta: string }
  | {
      type: 'response.reasoning_summary_part.done'
      part?: { type?: string; text?: string }
    }
  | { type: 'response.reasoning_text.delta'; delta: string }
  | { type: 'response.reasoning_text.done'; text: string }
  | {
      type: 'response.output_item.added'
      output_index?: number
      item?: {
        type?: string
        id?: string
        call_id?: string
        name?: string
        arguments?: string
      }
    }
  | {
      type: 'response.function_call_arguments.delta'
      output_index?: number
      item_id?: string
      delta: string
    }
  | {
      type: 'response.output_item.done'
      output_index?: number
      item?: {
        type?: string
        id?: string
        call_id?: string
        name?: string
        arguments?: string
      }
    }
  | {
      type: 'response.completed'
      response?: OpenAIResponsesNonStreamResponse
    }

type ToolCallState = {
  id: string
  name: string
  argumentsAccumulated: string
  emittedStart: boolean
  emittedEnd: boolean
}

// === OpenAI Responses 流式标准化器 ===

export class OpenAIResponsesStreamNormalizer implements StreamNormalizer<OpenAIResponsesStreamEvent> {
  private reasoningStarted = false
  private reasoningEnded = false
  private reasoningAccumulated = ''
  private textStarted = false
  private textAccumulated = ''
  private inputTokens = 0
  private outputTokens = 0
  private stopReason = 'end_turn'
  private toolCalls: Map<string, ToolCallState> = new Map()

  push(chunk: OpenAIResponsesStreamEvent): AgentEvent[] {
    const events: AgentEvent[] = []

    switch (chunk.type) {
      case 'response.output_text.delta':
        if (!this.textStarted) {
          this.textStarted = true
          events.push({ type: 'text_start' })
        }
        this.textAccumulated += chunk.delta
        events.push({ type: 'text_delta', delta: chunk.delta })
        break

      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        this.appendReasoningDelta(chunk.delta, events)
        break

      case 'response.reasoning_summary_part.done':
        if (
          !this.reasoningAccumulated &&
          chunk.part?.type === 'summary_text' &&
          typeof chunk.part.text === 'string'
        ) {
          this.appendReasoningDelta(chunk.part.text, events)
        }
        break

      case 'response.reasoning_text.done':
        if (!this.reasoningAccumulated) {
          this.appendReasoningDelta(chunk.text, events)
        }
        break

      case 'response.output_item.added':
        if (chunk.item?.type === 'function_call') {
          const state = this.getToolState(this.getToolKey(chunk))
          this.updateToolState(state, chunk.item)
          if (!state.emittedStart && state.id && state.name) {
            state.emittedStart = true
            events.push({ type: 'tool_start', toolCallId: state.id, toolName: state.name })
          }
        }
        break

      case 'response.function_call_arguments.delta': {
        const state = this.getToolState(this.getToolKey(chunk))
        state.argumentsAccumulated += chunk.delta
        if (state.emittedStart) {
          events.push({ type: 'tool_input_delta', toolCallId: state.id, delta: chunk.delta })
        }
        break
      }

      case 'response.output_item.done':
        if (chunk.item?.type === 'function_call') {
          const state = this.getToolState(this.getToolKey(chunk))
          this.updateToolState(state, chunk.item)
          if (!state.emittedStart && state.id && state.name) {
            state.emittedStart = true
            events.push({ type: 'tool_start', toolCallId: state.id, toolName: state.name })
          }
          if (chunk.item.arguments && !state.argumentsAccumulated) {
            state.argumentsAccumulated = chunk.item.arguments
            if (state.emittedStart) {
              events.push({
                type: 'tool_input_delta',
                toolCallId: state.id,
                delta: chunk.item.arguments,
              })
            }
          }
          if (state.emittedStart && !state.emittedEnd) {
            state.emittedEnd = true
            events.push({ type: 'tool_end', toolCallId: state.id })
          }
        }
        break

      case 'response.completed':
        if (chunk.response?.usage) {
          this.inputTokens = chunk.response.usage.input_tokens ?? 0
          this.outputTokens = chunk.response.usage.output_tokens ?? 0
        }
        this.stopReason = this.inferStopReason(chunk.response)
        break

      default:
        break
    }

    return events
  }

  flush(): AgentEvent[] {
    const events: AgentEvent[] = []

    if (this.reasoningStarted && !this.reasoningEnded) {
      this.reasoningEnded = true
      events.push({ type: 'reasoning_end', fullText: this.reasoningAccumulated })
    }

    if (this.textStarted) {
      events.push({ type: 'text_end', fullText: this.textAccumulated })
    }

    for (const [, state] of this.toolCalls) {
      if (state.emittedStart && !state.emittedEnd) {
        state.emittedEnd = true
        events.push({ type: 'tool_end', toolCallId: state.id })
      }
    }

    return events
  }

  getStreamMeta(): StreamMeta {
    const usage: Usage = {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
    }
    return { usage, stopReason: this.stopReason }
  }

  private appendReasoningDelta(delta: string, events: AgentEvent[]): void {
    if (!delta) return
    if (!this.reasoningStarted) {
      this.reasoningStarted = true
      events.push({ type: 'reasoning_start' })
    }
    this.reasoningAccumulated += delta
    events.push({ type: 'reasoning_content', text: delta })
  }

  private getToolKey(
    chunk:
      | Extract<OpenAIResponsesStreamEvent, { type: 'response.output_item.added' }>
      | Extract<OpenAIResponsesStreamEvent, { type: 'response.function_call_arguments.delta' }>
      | Extract<OpenAIResponsesStreamEvent, { type: 'response.output_item.done' }>,
  ): string {
    if (chunk.output_index !== undefined) return String(chunk.output_index)
    if ('item_id' in chunk && chunk.item_id) return chunk.item_id
    if ('item' in chunk && chunk.item?.call_id) return chunk.item.call_id
    if ('item' in chunk && chunk.item?.id) return chunk.item.id
    return '0'
  }

  private getToolState(key: string): ToolCallState {
    let state = this.toolCalls.get(key)
    if (!state) {
      state = {
        id: '',
        name: '',
        argumentsAccumulated: '',
        emittedStart: false,
        emittedEnd: false,
      }
      this.toolCalls.set(key, state)
    }
    return state
  }

  private updateToolState(
    state: ToolCallState,
    item: { id?: string; call_id?: string; name?: string },
  ): void {
    if (item.call_id) state.id = item.call_id
    else if (item.id && !state.id) state.id = item.id
    if (item.name) state.name = item.name
  }

  private inferStopReason(response: OpenAIResponsesNonStreamResponse | undefined): string {
    if (!response) return this.stopReason
    if (response.output?.some((item) => item.type === 'function_call')) return 'tool_use'
    const reason = response.incomplete_details?.reason
    if (reason === 'max_output_tokens') return 'max_tokens'
    if (reason) return reason
    return 'end_turn'
  }
}
