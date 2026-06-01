import { Box, Text } from 'ink'
import React from 'react'

interface AssistantTextProps {
  content: string
}

/**
 * 助手文本消息组件 —— 渲染助手回复文本。
 * 简洁的纯文本渲染，保留换行和基本格式。
 * TODO: 后续可添加 Markdown 终端渲染支持。
 */
export function AssistantText({ content }: AssistantTextProps): React.ReactElement {
  if (!content) return <></>

  return (
    <Box marginTop={1} flexDirection="column">
      <Text>{content}</Text>
    </Box>
  )
}
