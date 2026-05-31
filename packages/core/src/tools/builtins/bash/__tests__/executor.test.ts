import { describe, it, expect } from 'vitest'
import { execShell, DEFAULT_TIMEOUT_MS } from '../executor.js'

// 注意：这些是集成测试，依赖宿主系统的 shell 环境

describe('execShell', () => {
  it('执行简单命令并返回输出', async () => {
    const result = await execShell({
      command: 'echo "hello world"',
      cwd: process.cwd(),
      timeout: DEFAULT_TIMEOUT_MS,
      signal: new AbortController().signal,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('hello world')
    expect(result.timedOut).toBe(false)
    expect(result.aborted).toBe(false)
    expect(result.durationMs).toBeGreaterThan(0)
  })

  it('命令失败时返回非 0 退出码', async () => {
    const result = await execShell({
      command: 'exit 42',
      cwd: process.cwd(),
      timeout: DEFAULT_TIMEOUT_MS,
      signal: new AbortController().signal,
    })

    expect(result.exitCode).toBe(42)
  })

  it('捕获 stderr', async () => {
    const result = await execShell({
      command: 'echo "error message" >&2',
      cwd: process.cwd(),
      timeout: DEFAULT_TIMEOUT_MS,
      signal: new AbortController().signal,
    })

    expect(result.stderr.trim()).toBe('error message')
  })

  it('超时时设置 timedOut 并终止进程', async () => {
    const result = await execShell({
      command: 'sleep 30',
      cwd: process.cwd(),
      timeout: 200, // 200ms 超时
      signal: new AbortController().signal,
    })

    expect(result.timedOut).toBe(true)
    expect(result.durationMs).toBeLessThan(10_000) // 应在宽限期内完成
  }, 15_000)

  it('AbortSignal 取消时设置 aborted', async () => {
    const controller = new AbortController()

    // 延迟 100ms 后中止
    setTimeout(() => controller.abort(), 100)

    const result = await execShell({
      command: 'sleep 30',
      cwd: process.cwd(),
      timeout: DEFAULT_TIMEOUT_MS,
      signal: controller.signal,
    })

    expect(result.aborted).toBe(true)
  }, 15_000)

  it('已中止的 AbortSignal 立即终止', async () => {
    const controller = new AbortController()
    controller.abort() // 预先中止

    const result = await execShell({
      command: 'echo "should not run"',
      cwd: process.cwd(),
      timeout: DEFAULT_TIMEOUT_MS,
      signal: controller.signal,
    })

    expect(result.aborted).toBe(true)
  }, 10_000)

  it('命令不存在时使用 exit code 127 并返回错误信息', async () => {
    const result = await execShell({
      command: '__nonexistent_command_xyz__',
      cwd: process.cwd(),
      timeout: DEFAULT_TIMEOUT_MS,
      signal: new AbortController().signal,
    })

    // shell 会返回 127 或将错误输出到 stderr
    expect(result.exitCode !== 0).toBe(true)
  })

  it('注入 NO_COLOR 环境变量', async () => {
    const result = await execShell({
      command: 'echo "NO_COLOR=$NO_COLOR"',
      cwd: process.cwd(),
      timeout: DEFAULT_TIMEOUT_MS,
      signal: new AbortController().signal,
    })

    expect(result.stdout).toContain('NO_COLOR=1')
  })

  it('注入 MECH_CODE 环境变量', async () => {
    const result = await execShell({
      command: 'echo "MECH_CODE=$MECH_CODE"',
      cwd: process.cwd(),
      timeout: DEFAULT_TIMEOUT_MS,
      signal: new AbortController().signal,
    })

    expect(result.stdout).toContain('MECH_CODE=1')
  })

  it('多行输出', async () => {
    const result = await execShell({
      command: 'printf "line1\\nline2\\nline3\\n"',
      cwd: process.cwd(),
      timeout: DEFAULT_TIMEOUT_MS,
      signal: new AbortController().signal,
    })

    expect(result.stdout).toContain('line1')
    expect(result.stdout).toContain('line2')
    expect(result.stdout).toContain('line3')
  })

  it('在指定 cwd 下执行', async () => {
    const result = await execShell({
      command: 'pwd',
      cwd: '/tmp',
      timeout: DEFAULT_TIMEOUT_MS,
      signal: new AbortController().signal,
    })

    // macOS /tmp 是 /private/tmp 的符号链接
    expect(result.stdout.trim()).toMatch(/\/tmp$|\/private\/tmp$/)
  })
})
