import { Box, Text } from 'ink'
import React from 'react'
import { colors, icons, layout, truncate } from '../../theme.js'

/** 单个工具调用的状态 */
export interface ToolCallState {
  id: string
  name: string
  input: string
  result?: string
  isError?: boolean
  done: boolean
}

interface ToolCallProps {
  tool: ToolCallState
}

/**
 * 工具调用组件 —— 显示状态图标、工具名、参数预览与结果摘要。
 */
export function ToolCall({ tool }: ToolCallProps): React.ReactElement {
  const statusIcon = tool.done
    ? tool.isError
      ? icons.toolError
      : icons.toolSuccess
    : icons.toolPending
  const statusColor = tool.done ? (tool.isError ? colors.error : colors.success) : colors.warning

  return (
    <Box flexDirection="column" marginLeft={layout.toolIndent} marginTop={0}>
      {/* 状态行：图标 + 工具名 + 参数预览 */}
      <Box gap={1}>
        <Text color={statusColor} bold>
          {statusIcon}
        </Text>
        <Text bold>{tool.name}</Text>
        {tool.input && <Text dimColor>{truncate(tool.input, layout.maxToolInputLen)}</Text>}
      </Box>

      {/* 结果行 */}
      {tool.result && (
        <Box marginLeft={2}>
          <Text color={tool.isError ? colors.error : colors.muted}>
            {truncate(tool.result, layout.maxToolResultLen)}
          </Text>
        </Box>
      )}
    </Box>
  )
}
