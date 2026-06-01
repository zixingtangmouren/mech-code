import { Box, Text } from 'ink'
import React from 'react'

interface AssistantTextProps {
  content: string
  /** 是否正在流式输出（显示光标） */
  isStreaming?: boolean
}

/**
 * 助手文本消息组件 —— 渲染助手回复文本。
 * 简洁的纯文本渲染，保留换行和基本格式。
 * TODO: 后续可添加 Markdown 终端渲染支持。
 */
export function AssistantText({ content, isStreaming }: AssistantTextProps): React.ReactElement {
  if (!content && !isStreaming) return <></>

  return (
    <Box marginTop={1} flexDirection="column">
      <Text>
        {content}
        {isStreaming && <Text dimColor>▍</Text>}
      </Text>
    </Box>
  )
}
