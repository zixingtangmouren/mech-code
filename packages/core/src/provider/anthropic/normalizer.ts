import type { AgentEvent, Usage } from '@mech-code/shared'
import type { StreamNormalizer, StreamMeta } from '../types.js'

// === Anthropic SSE 原始事件类型 ===

type AnthropicRawChunk =
  | { type: 'message_start'; message: { usage: { input_tokens: number; output_tokens: number } } }
  | {
      type: 'content_block_start'
      index: number
      content_block:
        | { type: 'text'; text: string }
        | { type: 'thinking'; thinking: string }
        | { type: 'tool_use'; id: string; name: string }
    }
  | {
      type: 'content_block_delta'
      index: number
      delta:
        | { type: 'text_delta'; text: string }
        | { type: 'thinking_delta'; thinking: string }
        | { type: 'input_json_delta'; partial_json: string }
    }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta'
      delta: { stop_reason: string; stop_sequence: string | null }
      usage: { output_tokens: number }
    }
  | { type: 'message_stop' }
  | { type: 'ping' }
  | { type: 'error'; error: { type: string; message: string } }

// === Block 状态（判别联合）===

type BlockState =
  | { type: 'text'; accumulated: string }
  | { type: 'thinking'; accumulated: string }
  | { type: 'tool_use'; toolCallId: string; toolName: string; accumulated: string }

// === Anthropic 流式标准化器 ===

export class AnthropicStreamNormalizer implements StreamNormalizer<AnthropicRawChunk> {
  private blocks: Map<number, BlockState> = new Map()
  private inputTokens = 0
  private outputTokens = 0
  private stopReason = 'end_turn'

  push(chunk: AnthropicRawChunk): AgentEvent[] {
    const events: AgentEvent[] = []

    switch (chunk.type) {
      case 'message_start':
        this.inputTokens = chunk.message.usage.input_tokens
        this.outputTokens = chunk.message.usage.output_tokens
        break

      case 'content_block_start': {
        const block = chunk.content_block
        if (block.type === 'text') {
          this.blocks.set(chunk.index, { type: 'text', accumulated: block.text ?? '' })
          events.push({ type: 'text_start' })
        } else if (block.type === 'thinking') {
          this.blocks.set(chunk.index, { type: 'thinking', accumulated: '' })
          events.push({ type: 'reasoning_start' })
        } else if (block.type === 'tool_use') {
          this.blocks.set(chunk.index, {
            type: 'tool_use',
            toolCallId: block.id,
            toolName: block.name,
            accumulated: '',
          })
          events.push({ type: 'tool_start', toolCallId: block.id, toolName: block.name })
        }
        break
      }

      case 'content_block_delta': {
        const state = this.blocks.get(chunk.index)
        if (!state) break

        const delta = chunk.delta
        if (delta.type === 'text_delta' && state.type === 'text') {
          state.accumulated += delta.text
          events.push({ type: 'text_delta', delta: delta.text })
        } else if (delta.type === 'thinking_delta' && state.type === 'thinking') {
          state.accumulated += delta.thinking
          events.push({ type: 'reasoning_content', text: delta.thinking })
        } else if (delta.type === 'input_json_delta' && state.type === 'tool_use') {
          state.accumulated += delta.partial_json
          events.push({
            type: 'tool_input_delta',
            toolCallId: state.toolCallId,
            delta: delta.partial_json,
          })
        }
        break
      }

      case 'content_block_stop': {
        const state = this.blocks.get(chunk.index)
        if (state?.type === 'text') {
          events.push({ type: 'text_end', fullText: state.accumulated })
        } else if (state?.type === 'thinking') {
          events.push({ type: 'reasoning_end', fullText: state.accumulated })
        } else if (state?.type === 'tool_use') {
          events.push({ type: 'tool_end', toolCallId: state.toolCallId })
        }
        break
      }

      case 'message_delta':
        this.outputTokens = chunk.usage.output_tokens
        this.stopReason = chunk.delta.stop_reason ?? 'end_turn'
        break

      case 'message_stop':
      case 'ping':
      case 'error':
        break
    }

    return events
  }

  flush(): AgentEvent[] {
    this.blocks.clear()
    return []
  }

  getStreamMeta(): StreamMeta {
    const usage: Usage = {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
    }
    return { usage, stopReason: this.stopReason }
  }
}
