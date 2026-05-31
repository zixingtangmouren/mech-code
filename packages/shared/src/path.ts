import { homedir } from 'node:os'

/**
 * 展开路径中的 ~ 为用户主目录。
 * 仅处理路径开头的 ~/ 或独立的 ~。
 */
export function expandPath(filePath: string): string {
  if (filePath === '~') return homedir()
  if (filePath.startsWith('~/')) {
    return homedir() + filePath.slice(1)
  }
  return filePath
}
