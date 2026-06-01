import { Box, Text } from 'ink'
import React from 'react'
import { colors, icons } from '../../theme.js'

interface UserMessageProps {
  content: string
}

/**
 * 用户消息组件 —— 绿色 ❯ 前缀，多行保持缩进对齐。
 */
export function UserMessage({ content }: UserMessageProps): React.ReactElement {
  return (
    <Box marginTop={1}>
      <Text color={colors.success} bold>
        {icons.prompt}{' '}
      </Text>
      <Text>{content}</Text>
    </Box>
  )
}
