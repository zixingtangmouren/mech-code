# Bash 工具设计文档

> 版本：v1.0.0 · 日期：2026-05-31

---

## 1. 设计目标

为 Agent 提供通用的 Shell 命令执行能力，使其能够完成文件系统操作以外的各类任务（安装依赖、运行测试、构建项目、操作 Git 等）。

### 核心需求

| 优先级 | 需求         | 说明                                         |
| ------ | ------------ | -------------------------------------------- |
| P0     | 命令执行     | 执行任意 shell 命令并返回结果                |
| P0     | 超时控制     | 防止命令无限挂起                             |
| P0     | 输出截断     | 避免超长输出爆掉 LLM 上下文窗口              |
| P0     | 中止信号     | 支持 AbortSignal 取消正在执行的命令          |
| P1     | 工作目录管理 | 持久化 cwd，跨命令保持目录状态               |
| P1     | 退出码语义   | 区分"命令失败"和"结果为空"（如 grep 返回 1） |
| P1     | 权限审批集成 | 与 HITL 中间件配合实现执行前确认             |
| P2     | 后台执行     | 支持长时间运行的进程不阻塞 Agent Loop        |
| P2     | 流式进度     | 长命令执行期间给出进度反馈                   |
| P2     | 安全限制     | 阻止明显危险的命令模式                       |

### 设计原则

1. **工具只声明事实，不做策略决策** — 遵循 Tool 协议设计原则
2. **最小化内核，策略外置** — 安全策略、权限控制由中间件负责
3. **可预测性** — 相同命令在相同状态下产生相同结果
4. **面向 LLM 的输出** — 输出格式化为 LLM 最容易理解的形式

---

## 2. 输入设计

### 2.1 Zod Schema

```typescript
const schema = z.object({
  command: z.string().min(1).describe('要执行的 shell 命令'),
  timeout: z
    .number()
    .int()
    .positive()
    .max(600_000)
    .optional()
    .describe('超时时间（毫秒），默认 30000，最大 600000'),
  cwd: z.string().optional().describe('执行命令的工作目录（绝对路径）。省略时使用当前会话工作目录'),
})
```

### 2.2 参数说明

| 参数      | 类型   | 必填 | 默认值   | 说明                               |
| --------- | ------ | ---- | -------- | ---------------------------------- |
| `command` | string | 是   | —        | 要执行的 shell 命令                |
| `timeout` | number | 否   | 30000    | 超时毫秒数，最大 600000（10 分钟） |
| `cwd`     | string | 否   | 会话 cwd | 执行目录，不持久化改变会话 cwd     |

### 2.3 设计决策：不包含 `description` 参数

与 Claude Code 不同，我们不在 schema 中加入 `description` 字段。原因：

- 描述信息应由 LLM 在消息 text 块中自然表达
- 减少每次工具调用的 token 开销
- 避免 LLM 在 description 上花费无意义的推理时间

### 2.4 设计决策：不包含 `run_in_background` 参数（P2 阶段再考虑）

后台执行涉及任务管理系统的设计（任务 ID、输出获取、状态通知），属于独立子系统。初版先实现同步阻塞执行，后续以独立工具或参数扩展的方式引入。

---

## 3. 输出设计

### 3.1 ToolOutput 结构

```typescript
interface BashToolOutput {
  content: string // 格式化后的命令输出（返回给 LLM）
  isError?: boolean // 命令是否执行失败
  metadata?: {
    exitCode: number // 原始退出码
    stdout: string // 原始 stdout（截断前）
    stderr: string // 原始 stderr（截断前）
    durationMs: number // 执行耗时
    truncated: boolean // 输出是否被截断
    killed: boolean // 是否被超时/中止杀掉
  }
}
```

### 3.2 输出格式化规则

返回给 LLM 的 `content` 字段遵循以下格式：

```
<stdout 内容>
[如果有 stderr]
<stderr>
<stderr 内容>
</stderr>
[如果被截断]
[输出已截断，共 N 行，显示前 M 行]
[如果退出码非 0 且语义上为错误]
Exit code: <code>
```

### 3.3 退出码语义化

不同命令对退出码有不同语义。直接把非 0 退出码标为 error 会误导 LLM：

```typescript
/** 命令退出码语义规则 */
const EXIT_CODE_SEMANTICS: Record<string, (code: number) => boolean> = {
  // grep/rg：1 = 无匹配（非错误），2+ = 真正错误
  grep: (code) => code >= 2,
  rg: (code) => code >= 2,
  // diff：1 = 文件不同（非错误），2+ = 真正错误
  diff: (code) => code >= 2,
  // test/[：1 = 条件为假（非错误），2+ = 语法错误
  test: (code) => code >= 2,
  '[': (code) => code >= 2,
  // find：1 = 部分目录不可达（非错误），2+ = 真正错误
  find: (code) => code >= 2,
}

// 默认语义：非 0 即为错误
const defaultIsError = (code: number) => code !== 0
```

---

## 4. 执行引擎

### 4.1 核心流程

```
validateInput()
    │
    ▼
解析 cwd（优先使用参数 cwd → 回退到会话 cwd）
    │
    ▼
spawn 子进程（shell: true）
    │
    ├── 绑定 AbortSignal → SIGTERM → (grace period) → SIGKILL
    ├── 绑定 timeout → SIGTERM → SIGKILL
    ├── stdout/stderr 流式收集 + 截断
    │
    ▼
进程退出
    │
    ▼
退出码语义判断 → 组装 ToolOutput
```

### 4.2 子进程管理

```typescript
interface ShellExecOptions {
  command: string
  cwd: string
  timeout: number
  signal: AbortSignal
  /** stdout/stderr 合并的最大字节数 */
  maxOutputBytes: number
  /** 进程被 kill 后的优雅退出等待时间 */
  killGracePeriodMs: number
  /** 环境变量（继承当前进程 + 覆盖） */
  env?: Record<string, string>
}

interface ShellExecResult {
  stdout: string
  stderr: string
  exitCode: number
  /** 是否因超时被杀 */
  timedOut: boolean
  /** 是否因 AbortSignal 被杀 */
  aborted: boolean
  /** 实际执行耗时（ms） */
  durationMs: number
}
```

### 4.3 Shell 选择策略

```typescript
// 根据平台选择默认 shell
function getDefaultShell(): string {
  // 优先使用用户的 SHELL 环境变量
  if (process.env.SHELL) return process.env.SHELL
  // macOS/Linux 默认 bash，Windows 默认 cmd
  return process.platform === 'win32' ? 'cmd.exe' : '/bin/bash'
}
```

**设计说明**：使用 `child_process.spawn` 而非 `exec`，因为：

- `exec` 有 200KB 的默认 maxBuffer 限制
- `spawn` 支持流式读取输出，便于实现截断和进度反馈
- `spawn` 对大输出更内存友好

### 4.4 超时与中止

```
超时触发 / AbortSignal
    │
    ▼ SIGTERM
子进程收到信号
    │
    ├── 进程在 grace period (5s) 内正常退出 → 收集输出
    │
    └── 超过 grace period
            │
            ▼ SIGKILL
        强制终止 → 输出可能不完整
```

### 4.5 输出截断策略

**为什么需要截断**：LLM 上下文窗口有限，过长输出浪费 token 且降低推理质量。

```typescript
/** 输出限制常量 */
const OUTPUT_LIMITS = {
  /** 最大输出字节数（收集到内存的上限） */
  MAX_OUTPUT_BYTES: 512 * 1024, // 512 KB
  /** 返回给 LLM 的最大字符数 */
  MAX_CONTENT_CHARS: 30_000, // ~30K 字符
  /** 截断时保留的尾部行数（保留最后的错误信息） */
  TAIL_RESERVE_LINES: 50,
}
```

截断策略采用**首尾保留**模式：

1. 保留开头部分（通常包含命令的主要输出）
2. 保留末尾部分（通常包含错误信息或总结）
3. 中间用 `[... 省略 N 行 ...]` 占位

```typescript
function truncateOutput(
  output: string,
  maxChars: number,
  tailLines: number,
): {
  content: string
  truncated: boolean
  totalLines: number
} {
  if (output.length <= maxChars) {
    return { content: output, truncated: false, totalLines: output.split('\n').length }
  }

  const lines = output.split('\n')
  const totalLines = lines.length

  // 保留尾部
  const tail = lines.slice(-tailLines)
  const tailStr = tail.join('\n')

  // 用剩余空间给头部
  const headBudget = maxChars - tailStr.length - 100 // 留一点给省略提示
  const headLines: string[] = []
  let headLen = 0
  for (const line of lines) {
    if (headLen + line.length + 1 > headBudget) break
    headLines.push(line)
    headLen += line.length + 1
  }

  const omitted = totalLines - headLines.length - tailLines
  const content = [...headLines, `\n[... 省略 ${omitted} 行 ...]\n`, ...tail].join('\n')

  return { content, truncated: true, totalLines }
}
```

---

## 5. 工作目录管理

### 5.1 设计方案

工作目录通过 `ToolRunContext.metadata['__shellCwd']` 持久化，跨多次工具调用保持：

```typescript
/**
 * 获取当前 shell 工作目录。
 * 优先级：参数 cwd > metadata 中缓存的 cwd > context.cwd（项目根）
 */
function resolveShellCwd(input: BashInput, context: ToolRunContext): string {
  if (input.cwd) return input.cwd
  const cached = context.metadata['__shellCwd'] as string | undefined
  return cached ?? context.cwd
}
```

### 5.2 cd 命令检测

当命令包含 `cd` 时，执行后需要探测新的 cwd 并更新缓存：

```typescript
/**
 * 命令执行后探测子进程的最终 cwd。
 * 通过在命令末尾追加 `; echo __CWD__=$(pwd)` 实现。
 */
function detectCwdChange(stdout: string): string | null {
  const marker = '__CWD__='
  const lines = stdout.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.startsWith(marker)) {
      return lines[i]!.slice(marker.length).trim()
    }
  }
  return null
}
```

### 5.3 cwd 更新策略

```typescript
// 在命令中检测是否包含 cd
function commandContainsCd(command: string): boolean {
  // 简单启发式：检测 cd 是否作为独立命令出现
  return /(?:^|[;&|])\s*cd\s/.test(command)
}

// 执行时如果包含 cd，追加 cwd 探测后缀
function wrapCommandForCwdDetection(command: string): string {
  return `${command}; echo "__CWD__=$(pwd)"`
}
```

**注意**：cwd 探测后缀的输出会在返回给 LLM 前被剥离。

---

## 6. 安全设计

### 6.1 分层安全模型

```
┌─────────────────────────────────────────────────┐
│ 层级 1：validateInput（工具内部，不可绕过）      │
│ - 基本输入合法性（空命令、路径注入等）           │
├─────────────────────────────────────────────────┤
│ 层级 2：危险命令检测（工具内部，输出警告）       │
│ - 不阻止执行，但在 metadata 中标记                │
│ - 供中间件做决策                                 │
├─────────────────────────────────────────────────┤
│ 层级 3：权限中间件（外部，策略可配）             │
│ - 读取 flags + metadata，决定 allow/ask/deny    │
│ - 抛 SuspendSignal 触发 HITL                    │
└─────────────────────────────────────────────────┘
```

### 6.2 validateInput — 工具固有约束

这里只放**无条件**应该拦截的校验：

```typescript
validateInput(input) {
  const { command, cwd } = input

  // 空命令
  if (!command.trim()) {
    return { valid: false, error: '命令不能为空' }
  }

  // cwd 必须是绝对路径
  if (cwd && !path.isAbsolute(cwd)) {
    return { valid: false, error: 'cwd 必须是绝对路径' }
  }

  // 阻止命令注入特征（空字节）
  if (command.includes('\0')) {
    return { valid: false, error: '命令包含非法的空字节字符' }
  }

  return { valid: true }
}
```

### 6.3 命令分类 — 供中间件消费

工具在 `metadata` 中输出命令的风险分类，供权限中间件决策：

```typescript
/** 命令风险等级 */
type CommandRiskLevel = 'safe' | 'normal' | 'dangerous'

/** 命令分类结果 */
interface CommandClassification {
  /** 风险等级 */
  risk: CommandRiskLevel
  /** 基础命令名（如 git, npm, rm） */
  baseCommand: string
  /** 是否为只读操作 */
  isReadOnly: boolean
  /** 危险原因（risk=dangerous 时提供） */
  dangerReason?: string
}
```

分类规则：

```typescript
/** 已知安全（只读）的命令 */
const SAFE_COMMANDS = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'find',
  'grep',
  'rg',
  'which',
  'whereis',
  'file',
  'stat',
  'echo',
  'printf',
  'pwd',
  'env',
  'whoami',
  'uname',
  'date',
  'du',
  'df',
  'tree',
  'less',
  'more',
  'sort',
  'uniq',
  'diff',
  'git status',
  'git log',
  'git diff',
  'git show',
  'git branch',
])

/** 已知危险的命令模式 */
const DANGEROUS_PATTERNS = [
  /\brm\s+(-[rRf]*\s+)*\//, // rm with absolute path
  /\brm\s+-[rRf]*\s/, // rm -rf
  /\bsudo\b/, // sudo
  /\bchmod\s+777\b/, // chmod 777
  /\bmkfs\b/, // mkfs
  /\bdd\s/, // dd
  /\b>\s*\/dev\//, // write to devices
  /\bgit\s+push\s+.*--force/, // force push
  /\bgit\s+reset\s+--hard/, // hard reset
  /\bcurl\b.*\|\s*(ba)?sh/, // curl | sh
  /\bwget\b.*\|\s*(ba)?sh/, // wget | sh
]
```

### 6.4 flags 定义

```typescript
flags: {
  readonly: false,      // bash 命令可能有副作用
  parallelSafe: true,   // 不同命令互不干扰，可并行执行
}
```

**`parallelSafe: true` 的理由**：不同的 bash 调用在独立子进程中执行，天然隔离。如果 LLM 在同一轮发出多个 bash 工具调用，可以并发执行。

---

## 7. 权限集成（与 HITL 协作）

### 7.1 设计哲学

Bash 工具本身**不做权限决策**。它通过 `flags` 和 `metadata` 提供事实信息，权限中间件基于这些信息做 allow/ask/deny 决策。

### 7.2 权限中间件的推荐实现

```typescript
// 权限中间件在 wrapToolCall 中拦截
wrapToolCall(next, ctx) {
  if (ctx.toolName !== 'bash') return next(ctx)

  const { command } = ctx.toolInput
  const classification = classifyCommand(command)

  // 安全命令：自动放行
  if (classification.risk === 'safe') {
    return next(ctx)
  }

  // 危险命令：可选择直接拒绝或要求确认
  if (classification.risk === 'dangerous') {
    throw new SuspendSignal('approval_required', {
      tool: 'bash',
      command,
      reason: classification.dangerReason,
      risk: 'dangerous',
    })
  }

  // 普通命令：根据策略决定
  // 例如：首次执行某命令前要求确认，确认后记住规则
  if (shouldAsk(command)) {
    throw new SuspendSignal('approval_required', {
      tool: 'bash',
      command,
      risk: 'normal',
    })
  }

  return next(ctx)
}
```

### 7.3 权限规则配置建议

```typescript
interface BashPermissionRule {
  /** 匹配模式：精确命令或前缀通配 */
  pattern: string // 如 "git *", "npm run *", "rm -rf *"
  /** 决策 */
  action: 'allow' | 'deny' | 'ask'
}

// 示例规则集
const DEFAULT_RULES: BashPermissionRule[] = [
  // 只读操作自动放行
  { pattern: 'ls *', action: 'allow' },
  { pattern: 'cat *', action: 'allow' },
  { pattern: 'git status', action: 'allow' },
  { pattern: 'git log *', action: 'allow' },
  { pattern: 'git diff *', action: 'allow' },

  // 包管理器允许
  { pattern: 'npm install *', action: 'allow' },
  { pattern: 'pnpm install *', action: 'allow' },

  // 危险操作拒绝
  { pattern: 'rm -rf /', action: 'deny' },
  { pattern: 'sudo *', action: 'deny' },
]
```

---

## 8. 动态 Prompt（getPrompt）

### 8.1 设计目标

根据运行时上下文引导 LLM 正确使用 bash 工具，避免它滥用 bash 执行其他工具已覆盖的操作。

### 8.2 实现

```typescript
getPrompt(context: ToolPromptContext): string {
  const { availableTools, cwd } = context
  const lines: string[] = [
    '执行 shell 命令并返回输出。',
    '',
    `当前工作目录: ${cwd}`,
    `Shell: ${getDefaultShell()}`,
    `操作系统: ${process.platform}`,
  ]

  // 根据可用的其他工具，引导 LLM 优先使用专用工具
  const toolPreferences: string[] = []
  if (availableTools.includes('read_file')) {
    toolPreferences.push('读取文件内容: 使用 read_file（不要使用 cat/head/tail）')
  }
  if (availableTools.includes('write_file')) {
    toolPreferences.push('写入文件: 使用 write_file（不要使用 echo > / cat <<EOF）')
  }
  if (availableTools.includes('edit_file')) {
    toolPreferences.push('编辑文件: 使用 edit_file（不要使用 sed/awk）')
  }
  if (availableTools.includes('list_dir')) {
    toolPreferences.push('列出目录: 使用 list_dir（不要使用 ls/find）')
  }

  if (toolPreferences.length > 0) {
    lines.push('')
    lines.push('## 工具使用优先级')
    lines.push('以下操作应优先使用专用工具而非 bash:')
    for (const pref of toolPreferences) {
      lines.push(`- ${pref}`)
    }
  }

  lines.push('')
  lines.push('## 使用指南')
  lines.push('- 多个独立命令可发起多次并行的 bash 调用')
  lines.push('- 有依赖关系的命令用 && 串联在一次调用中')
  lines.push('- 超时默认 30 秒，长时间命令（如安装依赖）应设置更大的 timeout')
  lines.push('- 命令的 stderr 和 stdout 会一起返回')
  lines.push('- 避免使用需要交互输入的命令（如 vim、less 的交互模式）')
  lines.push('- 避免执行会产生海量输出的命令，必要时用 | head -n 或 | tail -n 限制')

  return lines.join('\n')
}
```

---

## 9. 工具完整定义

```typescript
import { spawn } from 'node:child_process'
import { resolve, isAbsolute } from 'node:path'
import { z } from 'zod'
import { defineTool } from '../define.js'
import type { ToolRunContext, ToolOutput } from '../types.js'

export const bashTool = defineTool({
  name: 'bash',
  description: '执行 shell 命令并返回输出',

  schema: z.object({
    command: z.string().min(1).describe('要执行的 shell 命令'),
    timeout: z
      .number()
      .int()
      .positive()
      .max(600_000)
      .optional()
      .describe('超时时间（毫秒），默认 30000，最大 600000'),
    cwd: z
      .string()
      .optional()
      .describe('执行命令的工作目录（绝对路径）。省略时使用当前会话工作目录'),
  }),

  flags: {
    readonly: false,
    parallelSafe: true,
  },

  getPrompt(context) {
    /* 见上文 */
  },

  validateInput(input) {
    /* 见 6.2 节 */
  },

  async execute(input, context): Promise<ToolOutput> {
    /* 见下文 */
  },
})
```

---

## 10. 后台执行设计（P2）

### 10.1 方案概述

后台执行需要引入**任务管理**子系统。初步设计如下：

```typescript
// 扩展 schema
const schemaV2 = schema.extend({
  background: z.boolean().optional().describe('设为 true 以在后台执行，不阻塞当前对话'),
})

// 后台任务注册到 metadata 中
interface BackgroundTask {
  id: string
  command: string
  startedAt: number
  pid: number
  status: 'running' | 'completed' | 'failed'
  exitCode?: number
  outputPath: string // 输出持久化到临时文件
}
```

### 10.2 配套工具

后台执行需要配套一个 `task_status` 工具来查询/读取后台任务输出：

```typescript
// task_status 工具（独立工具，非 bash 子功能）
schema: z.object({
  task_id: z.string().describe('后台任务 ID'),
  action: z.enum(['status', 'output', 'kill']).describe('操作类型'),
})
```

### 10.3 暂不实现的理由

- 增加系统复杂度（任务生命周期管理、输出持久化）
- 需要事件通知机制（任务完成通知 LLM）
- 当前使用场景可通过设置较大 timeout 覆盖

---

## 11. 流式进度设计（P2）

### 11.1 设计方案

对于长时间运行的命令，可通过扩展 AgentEvent 体系提供进度信息：

```typescript
// 新增事件类型
interface BashProgressEvent {
  type: 'tool_progress'
  toolCallId: string
  data: {
    elapsedMs: number
    outputLines: number
    outputBytes: number
    /** 输出末尾的最后几行（实时预览） */
    lastLines: string[]
  }
}
```

### 11.2 触发条件

- 命令执行超过 2 秒后开始发送进度事件
- 每 2 秒或每 100 行输出发送一次
- 只在 CLI/TUI 层消费展示，不影响 LLM 交互

---

## 12. 环境变量处理

### 12.1 继承策略

子进程默认继承当前进程的环境变量，额外注入以下变量：

```typescript
const injectedEnv: Record<string, string> = {
  // 标识当前处于 agent 控制下（供脚本/工具检测）
  MECH_CODE: '1',
  // 禁用交互式分页器
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  // 关闭颜色输出（ANSI 转义码对 LLM 无意义且浪费 token）
  NO_COLOR: '1',
  TERM: 'dumb',
  // 确保 UTF-8 编码
  LANG: process.env.LANG ?? 'en_US.UTF-8',
}
```

### 12.2 设计考量

- `NO_COLOR=1` + `TERM=dumb`：消除 ANSI 颜色码，减少 token 噪声
- `GIT_PAGER=cat`：防止 git 命令进入交互式 less
- `MECH_CODE=1`：允许用户脚本检测到当前在 agent 环境中运行

---

## 13. 错误处理

### 13.1 错误分类

| 错误类型                               | 处理方式                         | isError |
| -------------------------------------- | -------------------------------- | ------- |
| 命令执行成功（exit 0）                 | 正常返回 stdout                  | false   |
| 命令失败（语义非错误，如 grep 无匹配） | 返回 stdout + 语义提示           | false   |
| 命令失败（语义为错误）                 | 返回 stdout + stderr + exit code | true    |
| 超时被杀                               | 返回已收集的输出 + 超时提示      | true    |
| AbortSignal 取消                       | 返回已收集的输出 + 中止提示      | true    |
| spawn 失败（命令不存在等）             | 返回系统错误信息                 | true    |
| cwd 不存在                             | validateInput 阶段拦截           | —       |

### 13.2 错误输出格式

```
[已收集的输出内容]

<error>
命令超时（已运行 30000ms），进程已终止。
已执行的命令: npm install
Exit code: 137 (SIGKILL)
</error>
```

---

## 14. 与现有工具的关系

### 14.1 职责边界

| 操作     | 推荐工具       | bash 工具        |
| -------- | -------------- | ---------------- |
| 读文件   | read_file      | 不推荐，但不阻止 |
| 写文件   | write_file     | 不推荐，但不阻止 |
| 编辑文件 | edit_file      | 不推荐，但不阻止 |
| 列目录   | list_dir       | 不推荐，但不阻止 |
| Git 操作 | bash           | ✓ 主场景         |
| 安装依赖 | bash           | ✓ 主场景         |
| 运行测试 | bash           | ✓ 主场景         |
| 构建项目 | bash           | ✓ 主场景         |
| 搜索代码 | bash (grep/rg) | ✓ 合理使用       |

### 14.2 与 getPrompt() 的协作

通过 `getPrompt()` 动态告知 LLM 工具间的优先关系，但不做硬性限制。LLM 可能有合理理由使用 bash 做文件操作（如 `chmod`、`ln -s` 等没有专用工具的操作）。

---

## 15. 文件结构

```
packages/core/src/tools/builtins/
├── bash/
│   ├── index.ts              # 导出 bashTool
│   ├── executor.ts           # Shell 执行引擎（spawn、超时、中止）
│   ├── output.ts             # 输出处理（截断、格式化、cwd 探测）
│   ├── classifier.ts         # 命令分类（风险等级、只读判断）
│   ├── semantics.ts          # 退出码语义规则
│   └── __tests__/
│       ├── executor.test.ts
│       ├── output.test.ts
│       ├── classifier.test.ts
│       └── semantics.test.ts
├── edit-file.ts
├── read-file.ts
├── write-file.ts
├── list-dir.ts
└── index.ts                  # 增加 bashTool 导出
```

**选择子目录结构的理由**：bash 工具的复杂度显著高于其他内置工具，独立目录便于模块化管理和测试。

---

## 16. 实现路径

### Phase 1 — 最小可行版本

- [ ] `executor.ts`：spawn 执行 + 超时 + AbortSignal
- [ ] `output.ts`：基础截断（超过 30K 字符截断）
- [ ] `semantics.ts`：grep/diff/find/test 的退出码规则
- [ ] `index.ts`：bashTool 定义（schema + flags + execute）
- [ ] 基础测试

### Phase 2 — 完善体验

- [ ] `classifier.ts`：命令风险分类
- [ ] `output.ts`：首尾保留截断策略
- [ ] cwd 持久化 + cd 探测
- [ ] `getPrompt()` 动态提示词
- [ ] 集成测试（与 Agent Loop 配合）

### Phase 3 — 高级功能

- [ ] 后台执行 + 任务管理
- [ ] 流式进度事件
- [ ] 权限中间件参考实现

---

## 17. 对比 Claude Code 的取舍

| 特性              | Claude Code                      | mech-code                    | 理由                         |
| ----------------- | -------------------------------- | ---------------------------- | ---------------------------- |
| 沙箱              | 完整的文件系统/网络沙箱          | 不实现                       | 复杂度过高，非核心需求       |
| sed 特殊处理      | 完整（预览 + 精确写入）          | 不实现                       | 有 edit_file 工具替代        |
| 安全检查          | 非常重（AST 解析、zsh 特有检测） | 轻量级（正则分类）           | 我们定位不同，信任用户审批   |
| UI 渲染           | React 组件（可折叠、进度条）     | 事件系统（CLI 层渲染）       | 关注点分离                   |
| description 参数  | 有                               | 无                           | 减少 token，自然语言描述即可 |
| run_in_background | 内置参数                         | P2 独立系统                  | 降低初始复杂度               |
| 权限规则引擎      | 内置于工具                       | 外部中间件                   | 遵循"工具不做策略决策"原则   |
| 命令注入防护      | 极深（100+ 模式）                | 基础（空字节、明显危险模式） | 依赖 HITL 审批作为安全底线   |

---

## 18. 开放问题

1. **是否需要 `shell` 参数**：允许指定 bash/zsh/sh？当前方案默认使用用户 SHELL，不暴露参数。
2. **环境变量持久化**：命令中 `export FOO=bar` 后，后续命令是否可见？当前方案每次 spawn 新进程，不持久化。如需持久化需引入 shell session 概念。
3. **Windows 支持**：当前设计面向 Unix，Windows 上 cmd/powershell 的行为差异需后续考虑。
4. **输出编码**：假设 UTF-8，遇到二进制输出如何处理？建议检测后返回 `[二进制输出，共 N 字节]`。
