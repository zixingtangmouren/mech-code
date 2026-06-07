/**
 * bash 工具 —— 执行 Shell 命令并返回结果。
 *
 * 为 Agent 提供通用的 Shell 命令执行能力，支持：
 * - 超时控制与 AbortSignal 取消
 * - 跨调用工作目录持久化（通过 state.shellCwd）
 * - 退出码语义化（grep/diff/find 等命令的特殊语义）
 * - 超长输出截断（首尾保留策略）
 * - 命令风险分类（供权限中间件消费）
 */

import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { defineTool } from '@mech-code/core'
import type { ToolRunContext } from '@mech-code/core'
import { classifyCommand } from './classifier.js'
import { execShell, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from './executor.js'
import {
  commandContainsCd,
  extractCwdFromOutput,
  formatOutput,
  wrapCommandForCwdDetection,
} from './output.js'
import { isCommandError } from './semantics.js'

// === 辅助函数 ===

/**
 * 解析本次命令使用的工作目录。
 * 优先级：参数 cwd > state.shellCwd > props.cwd（项目根）
 */
function resolveShellCwd(inputCwd: string | undefined, context: ToolRunContext): string {
  if (inputCwd) return inputCwd
  const cached = context.state['shellCwd']
  if (typeof cached === 'string' && cached) return cached
  return typeof context.props.cwd === 'string' ? context.props.cwd : process.cwd()
}

// === 工具定义 ===

export const bashTool = defineTool({
  name: 'bash',
  description: '执行 shell 命令并返回输出',

  schema: z.object({
    command: z.string().min(1).describe('要执行的 shell 命令'),
    timeout: z
      .number()
      .int()
      .positive()
      .max(MAX_TIMEOUT_MS)
      .optional()
      .describe(`超时时间（毫秒），默认 ${DEFAULT_TIMEOUT_MS}，最大 ${MAX_TIMEOUT_MS}`),
    cwd: z
      .string()
      .optional()
      .describe('执行命令的工作目录（绝对路径）。省略时使用当前会话工作目录'),
  }),

  flags: {
    // bash 命令可能有副作用，不能声明为只读
    readonly: false,
    // 不同命令在独立子进程中执行，天然隔离，可并行
    parallelSafe: true,
  },

  validateInput(input) {
    const { command, cwd } = input

    // 空命令（Zod min(1) 已拦截，此处作为防御性校验保留）
    if (!command.trim()) {
      return { valid: false, error: '命令不能为空' }
    }

    // cwd 必须是绝对路径
    if (cwd !== undefined && !isAbsolute(cwd)) {
      return { valid: false, error: 'cwd 必须是绝对路径' }
    }

    // 拦截空字节（命令注入基础防御）
    if (command.includes('\0')) {
      return { valid: false, error: '命令包含非法的空字节字符' }
    }

    return { valid: true }
  },

  async execute(input, context: ToolRunContext) {
    const { command, timeout = DEFAULT_TIMEOUT_MS } = input

    // 解析工作目录
    const shellCwd = resolveShellCwd(input.cwd, context)

    // 判断是否需要探测 cwd 变化
    const needsCwdDetection = commandContainsCd(command)
    const execCommand = needsCwdDetection ? wrapCommandForCwdDetection(command) : command

    // 执行命令
    const result = await execShell({
      command: execCommand,
      cwd: shellCwd,
      timeout,
      signal: context.runtime.signal,
    })

    // 更新 cwd 缓存
    if (needsCwdDetection) {
      const newCwd = extractCwdFromOutput(result.stdout)
      if (newCwd) {
        context.state['shellCwd'] = newCwd
      }
    }

    // 判断退出码语义
    const isError = isCommandError(command, result.exitCode)

    // 分类命令（供权限中间件/事件消费，不影响执行逻辑）
    const classification = classifyCommand(command)

    // 格式化输出
    const formatted = formatOutput({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      isSemanticError: isError,
      timedOut: result.timedOut,
      aborted: result.aborted,
      durationMs: result.durationMs,
    })

    return {
      content: formatted.content,
      isError: formatted.isError,
      metadata: {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        truncated: formatted.stdoutTruncated,
        killed: result.timedOut || result.aborted,
        // 风险分类信息，供权限中间件消费
        classification,
      },
    }
  },
})
