import { Box, Text, useApp } from 'ink'
import React, { useState, useCallback, useRef } from 'react'
import type { Agent, AgentState } from '@mech-code/core'
import { createAgentState } from '@mech-code/core'
import { getTodoState } from '@mech-code/middleware'
import type { AgentEvent, Usage } from '@mech-code/shared'
import { InputBox } from './InputBox.js'
import { MessageList } from './MessageList.js'
import type { HistoryEntry } from './MessageList.js'
import { Header } from './Header.js'
import { StatusBar } from './StatusBar.js'
import { Spinner } from './Spinner.js'
import { TodoPanel } from './TodoPanel.js'
import { parseSlashCommand, executeSlashCommand } from '../commands.js'
import { colors } from '../theme.js'

/** 会话状态机 */
type SessionStatus = 'idle' | 'processing'

interface SessionProps {
  agent: Agent
  /** 当前使用的模型名 */
  model: string
  /** 当前工作目录 */
  cwd: string
}

/**
 * 会话容器 —— 管理完整的对话生命周期。
 * 持有 AgentState，处理输入/输出/中断逻辑。
 */
export function Session({ agent, model, cwd }: SessionProps): React.ReactElement {
  const { exit } = useApp()
  const [status, setStatus] = useState<SessionStatus>('idle')
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [currentEvents, setCurrentEvents] = useState<AgentEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [totalUsage, setTotalUsage] = useState<Usage | null>(null)
  const [spinnerLabel, setSpinnerLabel] = useState('思考中...')
  const [processingStartTime, setProcessingStartTime] = useState<number>(0)
  const [todoRevision, setTodoRevision] = useState(0)

  const stateRef = useRef<AgentState>(createAgentState())
  const abortRef = useRef<AbortController | null>(null)
  const visibleTodos = getVisibleTodos(stateRef.current)

  // 中断当前生成
  const handleInterrupt = useCallback(() => {
    abortRef.current?.abort()
  }, [])

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
            setTotalUsage(null)
            setTodoRevision((prev) => prev + 1)
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
      setSpinnerLabel('思考中...')
      setProcessingStartTime(Date.now())

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

          // 更新 spinner 标签
          if (event.type === 'tool_start' && event.toolName !== 'write_todos') {
            setSpinnerLabel(`执行 ${event.toolName}...`)
          } else if (event.type === 'tool_end' && event.toolName !== 'write_todos') {
            setSpinnerLabel('思考中...')
          } else if (event.type === 'reasoning_start') {
            setSpinnerLabel('思考中...')
          }

          // 累计 token 用量
          if (event.type === 'turn_end' && event.usage) {
            setTotalUsage((prev) => {
              if (!prev) return event.usage
              return {
                inputTokens: prev.inputTokens + event.usage.inputTokens,
                outputTokens: prev.outputTokens + event.usage.outputTokens,
                cacheReadTokens: (prev.cacheReadTokens ?? 0) + (event.usage.cacheReadTokens ?? 0),
              }
            })
          }

          if (event.type === 'tool_result' && event.toolName === 'write_todos') {
            setTodoRevision((prev) => prev + 1)
          }
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
      {/* 欢迎头部 */}
      <Header model={model} cwd={cwd} />

      {/* 消息列表 */}
      <MessageList
        history={history}
        currentEvents={status === 'processing' ? currentEvents : undefined}
      />

      <TodoPanel key={todoRevision} todos={visibleTodos} />

      {/* 处理中指示 */}
      {status === 'processing' && currentEvents.length === 0 && (
        <Box marginTop={1}>
          <Spinner label={spinnerLabel} startTime={processingStartTime} />
        </Box>
      )}

      {/* 工具执行时也显示 spinner (当有事件但最后一个工具还未完成) */}
      {status === 'processing' && currentEvents.length > 0 && isLastToolPending(currentEvents) && (
        <Box marginTop={0}>
          <Spinner label={spinnerLabel} startTime={processingStartTime} />
        </Box>
      )}

      {/* 错误信息 */}
      {error && (
        <Box marginTop={1}>
          <Text color={colors.error}>✗ 错误: {error}</Text>
        </Box>
      )}

      {/* 输入框 */}
      <InputBox
        onSubmit={(text) => {
          void handleSubmit(text)
        }}
        disabled={status === 'processing'}
        onInterrupt={handleInterrupt}
      />

      {/* 状态栏 */}
      <StatusBar model={model} usage={totalUsage} />
    </Box>
  )
}

function getVisibleTodos(state: AgentState) {
  return getTodoState(state.store).visibleItems
}

/** 检查最后一个工具调用是否仍在执行中 */
function isLastToolPending(events: AgentEvent[]): boolean {
  let lastToolId: string | null = null
  const doneTools = new Set<string>()

  for (const event of events) {
    if (event.type === 'tool_start') {
      lastToolId = event.toolCallId
    } else if (event.type === 'tool_end' || event.type === 'tool_result') {
      doneTools.add(event.toolCallId)
    }
  }

  return lastToolId !== null && !doneTools.has(lastToolId)
}
