import { Box, Text, useInput } from 'ink'
import React, { useState } from 'react'

interface InputBoxProps {
  /** 输入完成回调 */
  onSubmit: (text: string) => void
  /** 是否禁用输入（如 Agent 正在处理中） */
  disabled?: boolean
  /** 提示符 */
  prompt?: string
}

/**
 * 多行文本输入组件。
 * - Enter: 发送消息
 * - Ctrl+J: 换行
 * - Ctrl+C: 由上层处理中断
 */
export function InputBox({
  onSubmit,
  disabled = false,
  prompt = '>',
}: InputBoxProps): React.ReactElement {
  const [value, setValue] = useState('')

  useInput(
    (input, key) => {
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
    { isActive: !disabled },
  )

  const lines = value.split('\n')
  const isMultiLine = lines.length > 1

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="green" bold>
          {prompt}{' '}
        </Text>
        <Text>
          {disabled ? '' : value || ''}
          {!disabled && <Text color="gray">█</Text>}
        </Text>
      </Box>
      {!disabled && isMultiLine && <Text dimColor> (Ctrl+J 换行 | Enter 发送)</Text>}
    </Box>
  )
}
