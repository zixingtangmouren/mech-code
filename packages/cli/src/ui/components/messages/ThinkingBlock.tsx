import { Box, Text } from 'ink'
import React from 'react'
import { colors, icons, layout } from '../../theme.js'

interface ThinkingBlockProps {
  content: string
  /** 是否正在思考中（未结束） */
  isStreaming?: boolean
}

/**
 * 思考过程组件 —— dim italic 显示，默认折叠超长内容。
 */
export function ThinkingBlock({ content, isStreaming }: ThinkingBlockProps): React.ReactElement {
  if (!content) return <></>

  const lines = content.split('\n')
  const shouldTruncate = !isStreaming && lines.length > layout.maxThinkingLines
  const displayLines = shouldTruncate ? lines.slice(0, layout.maxThinkingLines) : lines
  const displayText = displayLines.join('\n')

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor italic>
        {icons.thinking} {displayText}
        {shouldTruncate && (
          <Text dimColor>
            {'\n'} … (+{lines.length - layout.maxThinkingLines} 行)
          </Text>
        )}
        {isStreaming && <Text color={colors.muted}>▍</Text>}
      </Text>
    </Box>
  )
}
