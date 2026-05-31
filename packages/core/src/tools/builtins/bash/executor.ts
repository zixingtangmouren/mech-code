/**
 * Shell 命令执行引擎。
 *
 * 负责：
 * 1. 使用 node:child_process.spawn 执行命令
 * 2. 超时控制（SIGTERM → grace period → SIGKILL）
 * 3. AbortSignal 取消支持
 * 4. 流式收集 stdout/stderr（字节上限保护）
 * 5. 注入工具环境变量（关闭颜色/分页器）
 */

import { spawn } from 'node:child_process'
import { BoundedOutputCollector, MAX_OUTPUT_BYTES } from './output.js'

// === 常量 ===

/** 默认执行超时（30 秒） */
export const DEFAULT_TIMEOUT_MS = 30_000

/** 最大允许超时（10 分钟） */
export const MAX_TIMEOUT_MS = 600_000

/** SIGTERM 后等待进程自行退出的宽限期（5 秒） */
const KILL_GRACE_PERIOD_MS = 5_000

// === 类型定义 ===

/** Shell 执行参数 */
export interface ShellExecOptions {
  /** 要执行的命令字符串 */
  command: string
  /** 工作目录（绝对路径） */
  cwd: string
  /** 超时毫秒数 */
  timeout: number
  /** 取消信号 */
  signal: AbortSignal
  /** 额外注入的环境变量（会与 injectedEnv 合并） */
  extraEnv?: Record<string, string>
}

/** Shell 执行结果 */
export interface ShellExecResult {
  /** 标准输出 */
  stdout: string
  /** 标准错误 */
  stderr: string
  /** 进程退出码 */
  exitCode: number
  /** 是否因超时被杀 */
  timedOut: boolean
  /** 是否因 AbortSignal 被中止 */
  aborted: boolean
  /** 实际执行耗时（ms） */
  durationMs: number
}

// === 环境变量注入 ===

/**
 * 获取注入给子进程的环境变量。
 *
 * 设计考量：
 * - NO_COLOR=1 + TERM=dumb：消除 ANSI 颜色码，减少 LLM token 噪声
 * - GIT_PAGER/PAGER=cat：防止 git、man 等命令进入交互式 less
 * - MECH_CODE=1：允许脚本检测到当前在 agent 环境中运行
 */
function getInjectedEnv(): Record<string, string> {
  return {
    MECH_CODE: '1',
    // 关闭颜色输出
    NO_COLOR: '1',
    TERM: 'dumb',
    // 关闭交互式分页器
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    // 关闭 git 交互式确认
    GIT_TERMINAL_PROMPT: '0',
    // 确保 UTF-8 编码（若用户未设置 LANG）
    ...(process.env['LANG'] ? {} : { LANG: 'en_US.UTF-8' }),
  }
}

// === 执行引擎 ===

/**
 * 获取使用的默认 shell。
 * 优先使用用户的 SHELL 环境变量；Windows 回退到 cmd.exe。
 */
function getDefaultShell(): string {
  if (process.env['SHELL']) return process.env['SHELL']
  return process.platform === 'win32' ? 'cmd.exe' : '/bin/bash'
}

/**
 * 执行 shell 命令并等待结果。
 *
 * stdout 和 stderr 分开收集，各有独立的字节限制。
 * 超时或 abort 时先发 SIGTERM，等待宽限期后再发 SIGKILL。
 */
export async function execShell(options: ShellExecOptions): Promise<ShellExecResult> {
  const { command, cwd, timeout, signal, extraEnv = {} } = options
  const startTime = Date.now()

  const stdoutCollector = new BoundedOutputCollector()
  const stderrCollector = new BoundedOutputCollector()

  let timedOut = false
  let aborted = false

  return new Promise<ShellExecResult>((resolve) => {
    // 合并环境变量：继承当前进程 > 注入变量 > 用户自定义
    const env = {
      ...process.env,
      ...getInjectedEnv(),
      ...extraEnv,
    }

    const shell = getDefaultShell()
    // 使用 -c 执行命令字符串
    const shellArgs = process.platform === 'win32' ? ['/c', command] : ['-c', command]

    const child = spawn(shell, shellArgs, {
      cwd,
      env,
      // 不使用 shell: true（已手动管理 shell 调用），避免双重 shell 嵌套
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    // 收集 stdout
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutCollector.append(chunk)
    })

    // 收集 stderr
    child.stderr.on('data', (chunk: Buffer) => {
      stderrCollector.append(chunk)
    })

    // 强制终止辅助函数
    function killProcess(reason: 'timeout' | 'abort'): void {
      if (reason === 'timeout') timedOut = true
      else aborted = true

      // 先发 SIGTERM（给进程优雅退出的机会）
      try {
        child.kill('SIGTERM')
      } catch {
        // 进程可能已经退出，忽略错误
      }

      // 宽限期后强制 SIGKILL
      const killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // 忽略
        }
      }, KILL_GRACE_PERIOD_MS)

      // Node.js 中 setTimeout 返回的 Timeout 对象有 unref 方法
      // 允许 timer 不阻止进程退出
      if (typeof killTimer === 'object' && killTimer !== null && 'unref' in killTimer) {
        killTimer.unref()
      }
    }

    // 超时控制
    const timeoutHandle = setTimeout(() => {
      killProcess('timeout')
    }, timeout)

    if (typeof timeoutHandle === 'object' && timeoutHandle !== null && 'unref' in timeoutHandle) {
      timeoutHandle.unref()
    }

    // AbortSignal 监听
    const abortHandler = (): void => {
      killProcess('abort')
    }

    if (signal.aborted) {
      // 已经 aborted，立即终止
      killProcess('abort')
    } else {
      signal.addEventListener('abort', abortHandler, { once: true })
    }

    // 进程退出
    child.on('close', (code) => {
      clearTimeout(timeoutHandle)
      signal.removeEventListener('abort', abortHandler)

      const durationMs = Date.now() - startTime

      resolve({
        stdout: stdoutCollector.toString(),
        stderr: stderrCollector.toString(),
        exitCode: code ?? (timedOut ? 124 : aborted ? 130 : 1),
        timedOut,
        aborted,
        durationMs,
      })
    })

    // spawn 错误（命令不存在等）
    child.on('error', (err) => {
      clearTimeout(timeoutHandle)
      signal.removeEventListener('abort', abortHandler)

      const durationMs = Date.now() - startTime

      // 将 spawn 错误写入 stderr
      const errorMessage = `spawn 失败: ${err.message}`
      const errBuf = Buffer.from(errorMessage, 'utf8')
      stderrCollector.append(errBuf)

      resolve({
        stdout: stdoutCollector.toString(),
        stderr: stderrCollector.toString(),
        exitCode: 127, // 命令未找到的惯用退出码
        timedOut: false,
        aborted: false,
        durationMs,
      })
    })
  })
}

// === 导出常量 ===
export { MAX_OUTPUT_BYTES }
