import { Box, Text } from 'ink'
import React from 'react'
import { colors, icons } from '../theme.js'
import type { Usage } from '@mech-code/shared'

interface StatusBarProps {
  /** 当前模型名 */
  model: string
  /** 累计 token 用量 */
  usage: Usage | null
}

/**
 * 底部状态栏 —— 显示模型信息、token 用量。
 */
export function StatusBar({ model, usage }: StatusBarProps): React.ReactElement {
  return (
    <Box marginTop={1}>
      <Text dimColor>
        {model}
        {usage && (
          <>
            {' '}
            {icons.separator} <Text color={colors.success}>↑{usage.inputTokens}</Text>{' '}
            <Text color={colors.warning}>↓{usage.outputTokens}</Text>
            {usage.cacheReadTokens ? <Text dimColor> (cache: {usage.cacheReadTokens})</Text> : ''}
          </>
        )}
      </Text>
    </Box>
  )
}
