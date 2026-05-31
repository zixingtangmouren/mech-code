/**
 * 命令风险分类器。
 *
 * 将 bash 命令分类为 safe / normal / dangerous 三个风险等级，
 * 供权限中间件做 allow/ask/deny 决策。
 *
 * 设计原则：工具不做策略决策，只提供事实分类结果。
 */

import { extractBaseCommand } from './semantics.js'

// === 类型定义 ===

/** 命令风险等级 */
export type CommandRiskLevel = 'safe' | 'normal' | 'dangerous'

/** 命令分类结果 */
export interface CommandClassification {
  /** 风险等级 */
  risk: CommandRiskLevel
  /** 基础命令名（如 git、npm、rm） */
  baseCommand: string
  /** 是否为只读操作（无副作用） */
  isReadOnly: boolean
  /** 危险原因（risk='dangerous' 时提供） */
  dangerReason?: string
}

// === 分类规则 ===

/**
 * 已知安全（只读、无副作用）的命令集合。
 * 这些命令可被权限中间件自动放行。
 */
const SAFE_COMMANDS = new Set([
  // 文件查看
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'bat',
  // 文件系统查询
  'ls',
  'dir',
  'tree',
  'find',
  'locate',
  'stat',
  'file',
  'du',
  'df',
  'lsof',
  // 文本处理（只读）
  'grep',
  'rg',
  'ag',
  'ack',
  'egrep',
  'fgrep',
  'wc',
  'sort',
  'uniq',
  'diff',
  'cmp',
  'cut',
  'awk',
  'sed', // sed 通常不带 -i，视为只读
  'tr',
  'col',
  'fold',
  'fmt',
  // 系统查询
  'pwd',
  'echo',
  'printf',
  'env',
  'printenv',
  'whoami',
  'id',
  'groups',
  'uname',
  'hostname',
  'date',
  'cal',
  'uptime',
  'ps',
  'top',
  'htop',
  'pgrep',
  'which',
  'whereis',
  'type',
  'command',
  // 网络查询（只读）
  'ping',
  'nslookup',
  'dig',
  'host',
  'nmap',
  'netstat',
  'ss',
  'ifconfig',
  'ip',
  // 代码/项目工具（只读模式）
  'git log',
  'git status',
  'git diff',
  'git show',
  'git branch',
  'git remote',
  'git stash list',
  'git tag',
  // 包管理器（查询）
  'npm list',
  'npm ls',
  'npm outdated',
  'npm audit',
  'pnpm list',
  'pnpm ls',
  'yarn list',
  // 帮助/版本
  'man',
  'help',
  'info',
])

/**
 * 已知危险的命令模式（正则 + 原因描述）。
 * 匹配到这些模式时，风险等级为 'dangerous'。
 */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // 递归删除
  {
    pattern: /\brm\s+(?:\S+\s+)*-[rRf]*[rR][rRf]*\s/,
    reason: '递归删除命令（rm -r 或 rm -rf）',
  },
  {
    pattern: /\brm\s+-[rRf]*[rR][rRf]*/,
    reason: '递归删除命令（rm -rf）',
  },
  // 删除根目录
  {
    pattern: /\brm\s+(?:\S+\s+)*\/\s*$/,
    reason: '删除根目录',
  },
  // sudo 提权
  {
    pattern: /(?:^|[;&|])\s*sudo\s/,
    reason: '需要 sudo 权限提升',
  },
  // curl/wget 管道执行
  {
    pattern: /\b(?:curl|wget)\b.*\|\s*(?:ba)?sh\b/,
    reason: '通过网络下载并直接执行脚本（供应链攻击风险）',
  },
  // 格式化磁盘
  {
    pattern: /\b(?:mkfs|fdisk|parted|diskutil\s+eraseDisk)\b/,
    reason: '磁盘格式化/分区操作',
  },
  // dd（覆写磁盘）
  {
    pattern: /\bdd\s+.*\bof=/,
    reason: 'dd 写入操作，可能覆盖磁盘',
  },
  // 写入设备文件
  {
    pattern: />\s*\/dev\/(?!null|zero$)/,
    reason: '向设备文件写入数据',
  },
  // git 强制推送
  {
    pattern: /\bgit\s+push\b.*(?:--force|-f)\b/,
    reason: 'Git 强制推送，会覆盖远程历史',
  },
  // git 硬重置
  {
    pattern: /\bgit\s+reset\s+--hard\b/,
    reason: 'Git 硬重置，会丢失本地修改',
  },
  // git 清理未跟踪文件
  {
    pattern: /\bgit\s+clean\s+.*-[df]/,
    reason: 'Git clean 删除未跟踪文件',
  },
  // 修改系统关键文件
  {
    pattern: /\b(?:chmod|chown)\s+.*\/(?:etc|bin|sbin|usr|lib|boot)\b/,
    reason: '修改系统目录的权限/所有者',
  },
  // 环境变量覆盖（安全敏感）
  {
    pattern: /\bexport\s+(?:PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_INSERT_LIBRARIES)\s*=/,
    reason: '修改关键环境变量（可能导致命令劫持）',
  },
  // 关闭/重启系统
  {
    pattern: /\b(?:shutdown|reboot|halt|poweroff|init\s+[06])\b/,
    reason: '关闭或重启系统',
  },
]

/**
 * 已知为只读操作的前缀模式（基础命令 + 子命令组合）。
 * 例如 "git status" 是只读的，尽管 "git" 整体不是。
 */
const READONLY_COMMAND_PREFIXES: string[] = [
  'git log',
  'git status',
  'git diff',
  'git show',
  'git branch',
  'git remote -v',
  'git remote show',
  'git stash list',
  'git tag',
  'git rev-parse',
  'git rev-list',
  'git cat-file',
  'npm list',
  'npm ls',
  'npm outdated',
  'npm audit',
  'pnpm list',
  'pnpm ls',
  'yarn list',
  'docker ps',
  'docker images',
  'docker inspect',
  'docker logs',
]

// === 公共 API ===

/**
 * 对命令进行风险分类。
 */
export function classifyCommand(command: string): CommandClassification {
  const trimmed = command.trim()
  const baseCommand = extractBaseCommand(trimmed)
  const normalizedCommand = trimmed.toLowerCase()

  // 1. 检查是否命中危险模式
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        risk: 'dangerous',
        baseCommand,
        isReadOnly: false,
        dangerReason: reason,
      }
    }
  }

  // 2. 检查是否为已知安全命令（精确前缀匹配）
  if (isSafeCommand(normalizedCommand, baseCommand)) {
    return {
      risk: 'safe',
      baseCommand,
      isReadOnly: true,
    }
  }

  // 3. 检查是否为已知只读前缀
  if (isReadOnlyPrefix(normalizedCommand)) {
    return {
      risk: 'safe',
      baseCommand,
      isReadOnly: true,
    }
  }

  // 4. 其余归类为普通风险
  return {
    risk: 'normal',
    baseCommand,
    isReadOnly: isKnownReadOnly(baseCommand, trimmed),
  }
}

/**
 * 判断命令是否匹配已知安全命令集。
 */
function isSafeCommand(normalizedCommand: string, baseCommand: string): boolean {
  // 精确匹配基础命令名
  if (SAFE_COMMANDS.has(baseCommand)) {
    // 排除 sed -i（原地编辑，有副作用）
    if (baseCommand === 'sed' && /\s-[a-z]*i/.test(normalizedCommand)) {
      return false
    }
    return true
  }

  // 匹配 "command subcommand" 前缀
  for (const safeCmd of SAFE_COMMANDS) {
    if (safeCmd.includes(' ') && normalizedCommand.startsWith(safeCmd)) {
      return true
    }
  }

  return false
}

/**
 * 判断命令是否匹配已知只读前缀。
 */
function isReadOnlyPrefix(normalizedCommand: string): boolean {
  for (const prefix of READONLY_COMMAND_PREFIXES) {
    if (normalizedCommand === prefix || normalizedCommand.startsWith(prefix + ' ')) {
      return true
    }
  }
  return false
}

/**
 * 基于基础命令名粗略判断是否为只读操作（补充逻辑）。
 */
function isKnownReadOnly(baseCommand: string, command: string): boolean {
  // 复合命令（含管道/分号/&&/||）不判定为只读
  if (/[|;&]/.test(command)) return false

  const readOnlyBases = new Set([
    'cat',
    'head',
    'tail',
    'grep',
    'rg',
    'find',
    'ls',
    'tree',
    'wc',
    'sort',
    'diff',
    'stat',
    'du',
    'df',
    'pwd',
    'echo',
    'env',
    'whoami',
    'uname',
    'date',
    'ps',
    'which',
  ])
  return readOnlyBases.has(baseCommand)
}
