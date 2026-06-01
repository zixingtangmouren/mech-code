import { Box, Text } from 'ink'
import React from 'react'
import { colors, icons } from '../theme.js'

interface HeaderProps {
  /** 当前模型名称 */
  model: string
  /** 当前工作目录 */
  cwd: string
}

/**
 * 欢迎头部 —— 显示应用标识、模型信息与工作目录。
 */
export function Header({ model, cwd }: HeaderProps): React.ReactElement {
  // 缩略显示路径：将 $HOME 替换为 ~
  const home = process.env['HOME'] ?? ''
  const displayPath = home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box gap={1}>
        <Text bold color={colors.primary}>
          {icons.dot} mech
        </Text>
        <Text dimColor>{icons.separator}</Text>
        <Text color={colors.accent}>{model}</Text>
        <Text dimColor>{icons.separator}</Text>
        <Text dimColor>{displayPath}</Text>
      </Box>
      <Box>
        <Text dimColor>
          输入消息开始对话 {icons.separator} /help 查看命令 {icons.separator} Esc 中断生成
        </Text>
      </Box>
    </Box>
  )
}
