import { useMemo } from 'react'
import type { AgentEvent, Usage } from '@mech-code/shared'
import type { ToolCallState } from '../components/messages/ToolCall.js'

/** 有序内容块 —— 文本段或工具调用，按事件流原始顺序排列 */
export type ContentBlock =
  | { type: 'text'; content: string; isStreaming: boolean }
  | { type: 'tool'; tool: ToolCallState }

/** 聚合后的结构化消息块 */
export interface AggregatedBlock {
  /** 思考过程（始终在最前，独立于 blocks 顺序） */
  thinking: string
  isThinkingStreaming: boolean
  /** 按原始顺序排列的文本段与工具调用 */
  blocks: ContentBlock[]
  usage: Usage | null
}

/**
 * 将 AgentEvent[] 流聚合为结构化的消息块。
 * 供 MessageList 和 StatusBar 消费。
 */
export function useEventAggregator(events: AgentEvent[]): AggregatedBlock {
  return useMemo(() => aggregateEvents(events), [events])
}

/**
 * 纯函数：将事件流聚合为有序渲染块。
 * 文本段和工具调用按事件流中的实际出现顺序排列，而非分组。
 */
export function aggregateEvents(events: AgentEvent[]): AggregatedBlock {
  const reasoningChunks: string[] = []
  const blocks: ContentBlock[] = []
  const toolMap = new Map<string, ToolCallState>()
  let usage: Usage | null = null
  let isThinkingStreaming = false

  for (const event of events) {
    switch (event.type) {
      case 'reasoning_start':
        isThinkingStreaming = true
        break
      case 'reasoning_content':
        reasoningChunks.push(event.text)
        break
      case 'reasoning_end':
        isThinkingStreaming = false
        break
      case 'text_start': {
        // 新建一个文本块（LLM 每段文本输出对应一个 text_start/text_end 对）
        blocks.push({ type: 'text', content: '', isStreaming: true })
        break
      }
      case 'text_delta': {
        // 追加到最后一个文本块；若无则创建（兼容没有 text_start 的情况）
        const last = blocks[blocks.length - 1]
        if (last?.type === 'text') {
          last.content += event.delta
        } else {
          blocks.push({ type: 'text', content: event.delta, isStreaming: true })
        }
        break
      }
      case 'text_end': {
        const last = blocks[blocks.length - 1]
        if (last?.type === 'text') last.isStreaming = false
        break
      }
      case 'tool_start': {
        const state: ToolCallState = {
          id: event.toolCallId,
          name: event.toolName,
          input: '',
          done: false,
        }
        toolMap.set(event.toolCallId, state)
        // 工具块插入到当前位置，保持与文本的相对顺序
        blocks.push({ type: 'tool', tool: state })
        break
      }
      case 'tool_input_delta': {
        const t = toolMap.get(event.toolCallId)
        if (t) t.input += event.delta
        break
      }
      case 'tool_executing': {
        const t = toolMap.get(event.toolCallId)
        if (t && event.input) {
          // 用完整 input 覆盖流式拼接的 delta
          t.input = typeof event.input === 'string' ? event.input : JSON.stringify(event.input)
        }
        break
      }
      case 'tool_result': {
        const t = toolMap.get(event.toolCallId)
        if (t) {
          t.result = typeof event.output === 'string' ? event.output : JSON.stringify(event.output)
          t.isError = event.isError
          t.done = true
        }
        break
      }
      case 'tool_end': {
        const t = toolMap.get(event.toolCallId)
        if (t) t.done = true
        break
      }
      case 'turn_end':
        usage = event.usage
        break
    }
  }

  return {
    thinking: reasoningChunks.join(''),
    isThinkingStreaming,
    blocks,
    usage,
  }
}
