import { Box } from 'ink'
import React from 'react'
import type { AgentEvent } from '@mech-code/shared'
import { UserMessage, AssistantText, ThinkingBlock, ToolCall } from './messages/index.js'
import { useEventAggregator } from '../hooks/useEventAggregator.js'

/** 历史消息条目 */
export interface HistoryEntry {
  role: 'user' | 'assistant'
  content: string
  events?: AgentEvent[]
}

interface MessageListProps {
  /** 完整的历史消息 */
  history: HistoryEntry[]
  /** 当前正在流式接收的事件（processing 状态时有值） */
  currentEvents?: AgentEvent[]
}

/**
 * 消息列表容器 —— 负责渲染整个对话历史和当前流式输出。
 */
export function MessageList({ history, currentEvents }: MessageListProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      {/* 历史消息 */}
      {history.map((entry, i) => (
        <HistoryMessage key={i} entry={entry} />
      ))}

      {/* 当前流式输出 */}
      {currentEvents && currentEvents.length > 0 && <StreamingMessage events={currentEvents} />}
    </Box>
  )
}

/** 渲染单条历史消息 */
function HistoryMessage({ entry }: { entry: HistoryEntry }): React.ReactElement {
  if (entry.role === 'user') {
    return <UserMessage content={entry.content} />
  }

  // 助手消息：如果有事件流，用结构化渲染；否则显示纯文本
  if (entry.events) {
    return <EventBlock events={entry.events} />
  }
  return <AssistantText content={entry.content} />
}

/** 渲染事件块（已完成的或正在流式的） */
function EventBlock({ events }: { events: AgentEvent[] }): React.ReactElement {
  const block = useEventAggregator(events)

  return (
    <Box flexDirection="column">
      {/* 思考过程始终在最前 */}
      {block.thinking && (
        <ThinkingBlock content={block.thinking} isStreaming={block.isThinkingStreaming} />
      )}

      {/* 按原始顺序渲染文本段与工具调用，保持穿插关系 */}
      {block.blocks.map((b, i) =>
        b.type === 'text' ? (
          <AssistantText key={i} content={b.content} isStreaming={b.isStreaming} />
        ) : (
          <ToolCall key={b.tool.id} tool={b.tool} />
        ),
      )}
    </Box>
  )
}

/** 流式消息（当前正在接收的事件） */
function StreamingMessage({ events }: { events: AgentEvent[] }): React.ReactElement {
  return <EventBlock events={events} />
}
