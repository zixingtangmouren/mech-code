/**
 * Slash 命令解析与执行。
 */

export interface SlashCommand {
  name: string
  args: string
}

export interface SlashCommandContext {
  clearHistory: () => void
  exit: () => void
}

const HELP_TEXT = `可用命令:
  /help   - 显示此帮助信息
  /clear  - 清空对话历史
  /exit   - 退出程序

快捷键:
  Enter   - 发送消息
  Ctrl+J  - 输入换行
  Ctrl+C  - 中断当前生成 / 退出`

/**
 * 解析 slash 命令。如果输入不是以 / 开头则返回 null。
 */
export function parseSlashCommand(input: string): SlashCommand | null {
  if (!input.startsWith('/')) return null
  const parts = input.slice(1).split(/\s+/)
  const name = parts[0]?.toLowerCase() ?? ''
  const args = parts.slice(1).join(' ')
  return { name, args }
}

/**
 * 执行 slash 命令。返回需要显示给用户的文本，或 null（无输出）。
 */
export function executeSlashCommand(cmd: SlashCommand, ctx: SlashCommandContext): string | null {
  switch (cmd.name) {
    case 'help':
      return HELP_TEXT
    case 'clear':
      ctx.clearHistory()
      return '对话历史已清空。'
    case 'exit':
    case 'quit':
      ctx.exit()
      return null
    default:
      return `未知命令: /${cmd.name}。输入 /help 查看可用命令。`
  }
}
