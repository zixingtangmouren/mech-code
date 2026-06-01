/**
 * 统一主题常量 —— 颜色、图标、布局。
 */

// === 颜色方案 ===
export const colors = {
  primary: 'cyan',
  success: 'green',
  error: 'red',
  warning: 'yellow',
  muted: 'gray',
  accent: 'magenta',
} as const

// === 图标 ===
export const icons = {
  /** 用户输入提示符 */
  prompt: '❯',
  /** 消息圆点指示器 */
  dot: '●',
  /** 工具状态 */
  toolPending: '⏳',
  toolSuccess: '✓',
  toolError: '✗',
  /** 思考过程前缀 */
  thinking: '💭',
  /** Token 统计 */
  stats: '↑',
  /** 分隔符 */
  separator: '│',
  /** 中断提示 */
  interrupt: '⏸',
} as const

// === Spinner 帧 ===
export const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

// === 布局 ===
export const layout = {
  /** 工具调用内容缩进 */
  toolIndent: 2,
  /** 最大工具输入预览长度 */
  maxToolInputLen: 120,
  /** 最大工具结果预览长度 */
  maxToolResultLen: 300,
  /** 思考内容最大显示行数 */
  maxThinkingLines: 5,
} as const

/**
 * 截断字符串，将换行替换为可视字符。
 */
export function truncate(str: string, maxLen: number): string {
  const oneLine = str.replace(/\n/g, ' ↵ ')
  if (oneLine.length <= maxLen) return oneLine
  return oneLine.slice(0, maxLen - 1) + '…'
}
