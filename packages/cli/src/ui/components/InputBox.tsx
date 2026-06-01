import { Box, Text, useInput } from 'ink'
import React, { useState } from 'react'
import { colors, icons } from '../theme.js'

interface InputBoxProps {
  /** 输入完成回调 */
  onSubmit: (text: string) => void
  /** 是否禁用输入（如 Agent 正在处理中） */
  disabled?: boolean
  /** 中断回调 */
  onInterrupt?: () => void
}

/**
 * 多行文本输入组件。
 * - Enter: 发送消息
 * - Ctrl+J: 换行
 * - Escape: 中断当前生成
 * - Ctrl+C: 退出
 */
export function InputBox({
  onSubmit,
  disabled = false,
  onInterrupt,
}: InputBoxProps): React.ReactElement {
  const [value, setValue] = useState('')

  useInput(
    (input, key) => {
      // Escape 中断（处理中时可用）
      if (key.escape && disabled && onInterrupt) {
        onInterrupt()
        return
      }

      if (disabled) return

      // Ctrl+J 换行
      if (key.ctrl && input === 'j') {
        setValue((prev) => prev + '\n')
        return
      }

      // Enter 发送
      if (key.return) {
        const trimmed = value.trim()
        if (trimmed) {
          onSubmit(trimmed)
          setValue('')
        }
        return
      }

      // Backspace 删除
      if (key.backspace || key.delete) {
        setValue((prev) => prev.slice(0, -1))
        return
      }

      // 普通字符输入
      if (input && !key.ctrl && !key.meta) {
        setValue((prev) => prev + input)
      }
    },
    { isActive: true },
  )

  const lines = value.split('\n')
  const isMultiLine = lines.length > 1

  if (disabled) {
    return (
      <Box marginTop={1}>
        <Text dimColor>{icons.interrupt} 按 Esc 中断生成</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={colors.success} bold>
          {icons.prompt}{' '}
        </Text>
        {value ? (
          <Text>
            {value}
            <Text color={colors.muted}>▍</Text>
          </Text>
        ) : (
          <Text dimColor>输入消息... (Ctrl+J 换行)</Text>
        )}
      </Box>
      {isMultiLine && <Text dimColor> ↩ Enter 发送 │ Ctrl+J 换行</Text>}
    </Box>
  )
}
