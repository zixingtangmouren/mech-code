import { Box, Text, useApp } from 'ink'
import React, { useState, useCallback, useRef } from 'react'
import type { Agent, AgentState } from '@mech/core'
import { createAgentState } from '@mech/core'
import type { AgentEvent } from '@mech/shared'
import { InputBox } from './InputBox.js'
import { MessageStream } from './MessageStream.js'
import { parseSlashCommand, executeSlashCommand } from '../commands.js'

/** 会话状态机 */
type SessionStatus = 'idle' | 'processing'

interface SessionProps {
  agent: Agent
}

/** 历史消息展示条目 */
interface HistoryEntry {
  role: 'user' | 'assistant'
  content: string
  events?: AgentEvent[]
}

/**
 * 会话容器 —— 管理完整的对话生命周期。
 * 持有 AgentState，处理输入/输出/中断逻辑。
 */
export function Session({ agent }: SessionProps): React.ReactElement {
  const { exit } = useApp()
  const [status, setStatus] = useState<SessionStatus>('idle')
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [currentEvents, setCurrentEvents] = useState<AgentEvent[]>([])
  const [error, setError] = useState<string | null>(null)

  const stateRef = useRef<AgentState>(createAgentState())
  const abortRef = useRef<AbortController | null>(null)

  // 处理用户提交消息
  const handleSubmit = useCallback(
    async (text: string) => {
      // 检查 slash 命令
      const cmd = parseSlashCommand(text)
      if (cmd) {
        const result = executeSlashCommand(cmd, {
          clearHistory: () => {
            setHistory([])
            stateRef.current = createAgentState()
          },
          exit,
        })
        if (result) {
          setHistory((prev) => [...prev, { role: 'assistant', content: result }])
        }
        return
      }

      // 追加用户消息到 state
      stateRef.current.messages.push({ role: 'user', content: text })
      setHistory((prev) => [...prev, { role: 'user', content: text }])
      setCurrentEvents([])
      setError(null)
      setStatus('processing')

      const abortController = new AbortController()
      abortRef.current = abortController

      try {
        const events: AgentEvent[] = []
        for await (const event of agent.run({
          state: stateRef.current,
          signal: abortController.signal,
        })) {
          events.push(event)
          setCurrentEvents([...events])
        }

        // 提取最终文本
        const textContent = events
          .filter((e) => e.type === 'text_delta')
          .map((e) => (e as { delta: string }).delta)
          .join('')

        setHistory((prev) => [...prev, { role: 'assistant', content: textContent, events }])
        setCurrentEvents([])
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          setHistory((prev) => [...prev, { role: 'assistant', content: '(已中断)' }])
        } else {
          const msg = err instanceof Error ? err.message : String(err)
          setError(msg)
        }
      } finally {
        setStatus('idle')
        abortRef.current = null
      }
    },
    [agent, exit],
  )

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* 欢迎信息 */}
      {history.length === 0 && (
        <Box marginBottom={1} flexDirection="column">
          <Text bold color="cyan">
            mech-code
          </Text>
          <Text dimColor>交互式 AI 助手。输入消息开始对话。</Text>
          <Text dimColor>Ctrl+J 换行 | Enter 发送 | /help 查看命令</Text>
        </Box>
      )}

      {/* 历史消息 */}
      {history.map((entry, i) => (
        <Box key={i} flexDirection="column" marginBottom={1}>
          {entry.role === 'user' ? (
            <Box>
              <Text color="blue" bold>
                {'You: '}
              </Text>
              <Text>{entry.content}</Text>
            </Box>
          ) : entry.events ? (
            <MessageStream events={entry.events} />
          ) : (
            <Box>
              <Text>{entry.content}</Text>
            </Box>
          )}
        </Box>
      ))}

      {/* 当前流式输出 */}
      {status === 'processing' && currentEvents.length > 0 && (
        <MessageStream events={currentEvents} />
      )}

      {/* 处理中指示 */}
      {status === 'processing' && currentEvents.length === 0 && (
        <Text color="yellow">思考中...</Text>
      )}

      {/* 错误信息 */}
      {error && (
        <Box marginBottom={1}>
          <Text color="red">错误: {error}</Text>
        </Box>
      )}

      {/* 输入框 */}
      <InputBox
        onSubmit={(text) => {
          void handleSubmit(text)
        }}
        disabled={status === 'processing'}
      />
    </Box>
  )
}
