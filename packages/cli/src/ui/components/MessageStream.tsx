import { Box, Text } from 'ink'
import React from 'react'
import type { AgentEvent } from '@mech-code/shared'

interface MessageStreamProps {
  /** 事件流，依次推送到组件 */
  events: AgentEvent[]
}

/** 工具调用状态 */
interface ToolCallState {
  id: string
  name: string
  input: string
  result?: string
  isError?: boolean
  done: boolean
}

/**
 * 流式消息渲染组件 —— 将 AgentEvent 序列渲染为终端输出。
 */
export function MessageStream({ events }: MessageStreamProps): React.ReactElement | null {
  // 从事件流中提取渲染状态
  const { textChunks, reasoningChunks, toolCalls, usage } = processEvents(events)

  if (events.length === 0) return null

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* 思考过程 */}
      {reasoningChunks.length > 0 && (
        <Box marginBottom={0}>
          <Text dimColor italic>
            {'💭 '}
            {reasoningChunks.join('')}
          </Text>
        </Box>
      )}

      {/* 正文文本 */}
      {textChunks.length > 0 && (
        <Box>
          <Text>{textChunks.join('')}</Text>
        </Box>
      )}

      {/* 工具调用 */}
      {toolCalls.map((tool) => (
        <ToolCallDisplay key={tool.id} tool={tool} />
      ))}

      {/* Token 用量 */}
      {usage && (
        <Box marginTop={0}>
          <Text dimColor>
            {'📊 '}tokens: {usage.input} in / {usage.output} out
            {usage.cacheRead ? ` (cache read: ${usage.cacheRead})` : ''}
          </Text>
        </Box>
      )}
    </Box>
  )
}

function ToolCallDisplay({ tool }: { tool: ToolCallState }): React.ReactElement {
  const statusIcon = tool.done ? (tool.isError ? '❌' : '✅') : '⏳'

  return (
    <Box flexDirection="column" marginY={0}>
      <Text>
        <Text color="yellow">
          {statusIcon} [{tool.name}]
        </Text>
        {tool.input && <Text dimColor> {truncate(tool.input, 100)}</Text>}
      </Text>
      {tool.result && (
        <Box marginLeft={2}>
          <Text color={tool.isError ? 'red' : 'gray'}>{truncate(tool.result, 200)}</Text>
        </Box>
      )}
    </Box>
  )
}

interface ProcessedState {
  textChunks: string[]
  reasoningChunks: string[]
  toolCalls: ToolCallState[]
  usage: { input: number; output: number; cacheRead?: number } | null
}

function processEvents(events: AgentEvent[]): ProcessedState {
  const textChunks: string[] = []
  const reasoningChunks: string[] = []
  const toolCalls: ToolCallState[] = []
  let usage: ProcessedState['usage'] = null

  // 用 Map 追踪工具调用状态
  const toolMap = new Map<string, ToolCallState>()

  for (const event of events) {
    switch (event.type) {
      case 'text_delta':
        textChunks.push(event.delta)
        break
      case 'reasoning_content':
        reasoningChunks.push(event.text)
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
      case 'tool_result': {
        const t = toolMap.get(event.toolCallId)
        if (t) {
          t.result = String(event.output)
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
        if (event.usage) {
          usage = {
            input: event.usage.inputTokens,
            output: event.usage.outputTokens,
            cacheRead: event.usage.cacheReadTokens,
          }
        }
        break
    }
  }

  toolCalls.push(...toolMap.values())
  return { textChunks, reasoningChunks, toolCalls, usage }
}

function truncate(str: string, maxLen: number): string {
  // 移除换行符用于紧凑展示
  const oneLine = str.replace(/\n/g, '↵')
  if (oneLine.length <= maxLen) return oneLine
  return oneLine.slice(0, maxLen - 3) + '...'
}
