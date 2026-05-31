/**
 * 命令退出码语义规则。
 *
 * 许多命令用退出码传递"结果信息"而非"是否出错"，
 * 例如 grep 返回 1 代表"无匹配"，并非执行错误。
 * 直接把非 0 退出码标为 isError 会误导 LLM，此模块负责语义化解释。
 */

// === 类型定义 ===

/**
 * 退出码语义判断函数。
 * 输入退出码，返回是否属于"真正的错误"。
 */
type ExitCodeIsError = (exitCode: number) => boolean

// === 语义规则表 ===

/**
 * 命令 → 退出码语义规则的映射表。
 * key 为命令名（基础命令，不含参数）。
 */
const EXIT_CODE_SEMANTICS: Map<string, ExitCodeIsError> = new Map([
  // grep/rg：0=有匹配，1=无匹配（非错误），2+=执行错误
  ['grep', (code) => code >= 2],
  ['rg', (code) => code >= 2],
  ['egrep', (code) => code >= 2],
  ['fgrep', (code) => code >= 2],
  ['ag', (code) => code >= 2],
  ['ack', (code) => code >= 2],

  // diff：0=无差异，1=有差异（非错误），2+=执行错误
  ['diff', (code) => code >= 2],
  ['diff3', (code) => code >= 2],
  ['git', (code) => code >= 2], // git diff 等命令有类似语义

  // find：0=成功，1=部分目录不可达（视为非错误），2+=执行错误
  ['find', (code) => code >= 2],

  // test/[：0=条件真，1=条件假（非错误），2+=语法错误
  ['test', (code) => code >= 2],
  ['[', (code) => code >= 2],

  // which：0=找到，1=未找到（非错误）
  ['which', (code) => code >= 2],
  ['command', (code) => code >= 2],
  ['type', (code) => code >= 2],

  // cmp：0=相同，1=不同（非错误），2+=执行错误
  ['cmp', (code) => code >= 2],

  // pkgutil/dpkg/rpm 等查询工具：未找到不是错误
  ['pkgutil', (code) => code >= 2],
  ['dpkg', (code) => code >= 2],
  ['rpm', (code) => code >= 2],
])

// === 公共 API ===

/**
 * 根据命令名获取对应的退出码语义判断函数。
 * 若命令无特殊语义规则，返回默认策略（非 0 即为错误）。
 */
export function getExitCodeSemantics(baseCommand: string): ExitCodeIsError {
  return EXIT_CODE_SEMANTICS.get(baseCommand) ?? ((code) => code !== 0)
}

/**
 * 判断命令执行结果是否为"真正的错误"。
 *
 * @param command 完整命令字符串（用于提取基础命令名）
 * @param exitCode 进程退出码
 */
export function isCommandError(command: string, exitCode: number): boolean {
  const baseCommand = extractBaseCommand(command)
  const isError = getExitCodeSemantics(baseCommand)
  return isError(exitCode)
}

/**
 * 从完整命令字符串中提取基础命令名。
 * 处理管道、环境变量前缀等情况。
 *
 * 示例：
 *   "grep -r foo ." → "grep"
 *   "FOO=bar npm run test" → "npm"
 *   "git diff HEAD" → "git"
 *   "cat file | grep pattern" → "cat"（取第一个命令）
 */
export function extractBaseCommand(command: string): string {
  // 按管道/分号/&&/|| 分割，取第一段
  const firstSegment = command.split(/[|;&]|&&|\|\|/)[0]?.trim() ?? ''

  // 跳过环境变量赋值前缀（VAR=val 形式）
  const parts = firstSegment.split(/\s+/)
  for (const part of parts) {
    if (/^[A-Za-z_]\w*=/.test(part)) {
      // 是环境变量赋值，跳过
      continue
    }
    // 提取命令名（去掉路径前缀，如 /usr/bin/grep → grep）
    return part.split('/').at(-1) ?? ''
  }

  return ''
}
