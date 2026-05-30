import type { AgentEvent, Usage } from '@mech/shared'
import type { StreamNormalizer, StreamMeta } from '../types.js'

// === OpenAI SSE chunk 类型 ===

type OpenAIChunk = {
  choices: Array<{
    index: number
    delta: {
      content?: string | null
      /** DeepSeek Reasoner 扩展字段：思考链文本 */
      reasoning_content?: string | null
      role?: string
      tool_calls?: Array<{
        index: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason: string | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

// === 工具调用中间状态 ===

type ToolCallState = {
  id: string
  name: string
  argumentsAccumulated: string
  emittedStart: boolean
}

// === OpenAI 流式标准化器 ===

export class OpenAIStreamNormalizer implements StreamNormalizer<OpenAIChunk> {
  private textStarted = false
  private textAccumulated = ''
  private reasoningStarted = false
  private reasoningAccumulated = ''
  private inputTokens = 0
  private outputTokens = 0
  private stopReason = 'end_turn'
  private toolCalls: Map<number, ToolCallState> = new Map()

  push(chunk: OpenAIChunk): AgentEvent[] {
    const events: AgentEvent[] = []

    // usage 通常出现在最后一个 chunk（stream_options.include_usage: true）
    if (chunk.usage) {
      this.inputTokens = chunk.usage.prompt_tokens
      this.outputTokens = chunk.usage.completion_tokens
    }

    const choice = chunk.choices[0]
    if (!choice) return events

    if (choice.finish_reason) {
      this.stopReason = this.mapFinishReason(choice.finish_reason)
    }

    const delta = choice.delta

    // 思考链内容（DeepSeek Reasoner 等）
    if (delta.reasoning_content) {
      if (!this.reasoningStarted) {
        this.reasoningStarted = true
        events.push({ type: 'reasoning_start' })
      }
      this.reasoningAccumulated += delta.reasoning_content
      events.push({ type: 'reasoning_content', text: delta.reasoning_content })
    }

    // 文本内容
    if (delta.content) {
      if (!this.textStarted) {
        this.textStarted = true
        events.push({ type: 'text_start' })
      }
      this.textAccumulated += delta.content
      events.push({ type: 'text_delta', delta: delta.content })
    }

    // 工具调用
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        let state = this.toolCalls.get(tc.index)
        if (!state) {
          state = {
            id: tc.id ?? '',
            name: tc.function?.name ?? '',
            argumentsAccumulated: '',
            emittedStart: false,
          }
          this.toolCalls.set(tc.index, state)
        }

        // 补全 id/name（部分 chunk 中才出现）
        if (tc.id) state.id = tc.id
        if (tc.function?.name) state.name += tc.function.name

        // 当 id 和 name 都齐全时 emit tool_start
        if (!state.emittedStart && state.id && state.name) {
          state.emittedStart = true
          events.push({ type: 'tool_start', toolCallId: state.id, toolName: state.name })
        }

        // 追加参数 delta
        if (tc.function?.arguments) {
          state.argumentsAccumulated += tc.function.arguments
          if (state.emittedStart) {
            events.push({
              type: 'tool_input_delta',
              toolCallId: state.id,
              delta: tc.function.arguments,
            })
          }
        }
      }
    }

    return events
  }

  flush(): AgentEvent[] {
    const events: AgentEvent[] = []

    // 关闭思考链块
    if (this.reasoningStarted) {
      events.push({ type: 'reasoning_end', fullText: this.reasoningAccumulated })
    }

    // 关闭文本块
    if (this.textStarted) {
      events.push({ type: 'text_end', fullText: this.textAccumulated })
    }

    // 关闭所有工具调用块
    for (const [, state] of this.toolCalls) {
      if (state.emittedStart) {
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

  private mapFinishReason(reason: string): string {
    switch (reason) {
      case 'stop':
        return 'end_turn'
      case 'tool_calls':
        return 'tool_use'
      case 'length':
        return 'max_tokens'
      case 'content_filter':
        return 'content_filter'
      default:
        return reason
    }
  }
}
