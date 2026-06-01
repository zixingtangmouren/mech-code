import { useMemo } from 'react'
import type { AgentEvent, Usage } from '@mech/shared'
import type { ToolCallState } from '../components/messages/ToolCall.js'

/** 聚合后的结构化消息块 */
export interface AggregatedBlock {
  text: string
  thinking: string
  toolCalls: ToolCallState[]
  usage: Usage | null
  /** 当前是否仍在流式接收中 */
  isThinkingStreaming: boolean
  isTextStreaming: boolean
}

/**
 * 将 AgentEvent[] 流聚合为结构化的消息块。
 * 供 MessageList 和 StatusBar 消费。
 */
export function useEventAggregator(events: AgentEvent[]): AggregatedBlock {
  return useMemo(() => aggregateEvents(events), [events])
}

/**
 * 纯函数：将事件流聚合为渲染块。
 */
export function aggregateEvents(events: AgentEvent[]): AggregatedBlock {
  const textChunks: string[] = []
  const reasoningChunks: string[] = []
  const toolMap = new Map<string, ToolCallState>()
  let usage: Usage | null = null
  let isThinkingStreaming = false
  let isTextStreaming = false

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
      case 'text_start':
        isTextStreaming = true
        break
      case 'text_delta':
        textChunks.push(event.delta)
        break
      case 'text_end':
        isTextStreaming = false
        break
      case 'tool_start': {
        const state: ToolCallState = {
          id: event.toolCallId,
          name: event.toolName,
          input: '',
          done: false,
        }
        toolMap.set(event.toolCallId, state)
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
    text: textChunks.join(''),
    thinking: reasoningChunks.join(''),
    toolCalls: [...toolMap.values()],
    usage,
    isThinkingStreaming,
    isTextStreaming,
  }
}
