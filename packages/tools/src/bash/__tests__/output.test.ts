import { describe, it, expect } from 'vitest'
import {
  truncateOutput,
  formatOutput,
  extractCwdFromOutput,
  commandContainsCd,
  wrapCommandForCwdDetection,
  CWD_MARKER,
  BoundedOutputCollector,
  MAX_OUTPUT_BYTES,
} from '../output.js'

describe('BoundedOutputCollector', () => {
  it('正常收集数据', () => {
    const collector = new BoundedOutputCollector()
    collector.append(Buffer.from('hello '))
    collector.append(Buffer.from('world'))
    expect(collector.toString()).toBe('hello world')
    expect(collector.truncated).toBe(false)
    expect(collector.size).toBe(11)
  })

  it('超过限制后截断', () => {
    const collector = new BoundedOutputCollector()
    const bigChunk = Buffer.alloc(MAX_OUTPUT_BYTES - 10, 'a')
    collector.append(bigChunk)
    expect(collector.truncated).toBe(false)

    // 再追加超过剩余空间的数据
    collector.append(Buffer.from('b'.repeat(100)))
    expect(collector.truncated).toBe(true)
    // 大小不超过上限
    expect(collector.size).toBeLessThanOrEqual(MAX_OUTPUT_BYTES)
  })

  it('已截断后忽略后续数据', () => {
    const collector = new BoundedOutputCollector()
    // 直接触发截断
    collector.append(Buffer.alloc(MAX_OUTPUT_BYTES + 1, 'x'))
    const sizeAfterTruncate = collector.size
    collector.append(Buffer.from('extra'))
    expect(collector.size).toBe(sizeAfterTruncate)
  })
})

describe('truncateOutput', () => {
  it('短内容不截断', () => {
    const result = truncateOutput('hello world')
    expect(result.truncated).toBe(false)
    expect(result.content).toBe('hello world')
    expect(result.totalLines).toBe(1)
  })

  it('超过限制时截断', () => {
    const longOutput = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n')
    const result = truncateOutput(longOutput, 500)
    expect(result.truncated).toBe(true)
    expect(result.content.length).toBeLessThanOrEqual(600) // 允许少量超出（省略提示）
    expect(result.content).toContain('省略')
    expect(result.totalLines).toBe(1000)
  })

  it('截断后保留首尾内容', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line-${i}`)
    const output = lines.join('\n')
    const result = truncateOutput(output, 500, 5)

    // 头部第一行应保留
    expect(result.content).toContain('line-0')
    // 尾部最后一行应保留
    expect(result.content).toContain('line-199')
  })

  it('空字符串', () => {
    const result = truncateOutput('')
    expect(result.content).toBe('')
    expect(result.truncated).toBe(false)
    expect(result.totalLines).toBe(0)
  })
})

describe('formatOutput', () => {
  const baseOptions = {
    stdout: 'hello world',
    stderr: '',
    exitCode: 0,
    isSemanticError: false,
    timedOut: false,
    aborted: false,
    durationMs: 100,
  }

  it('正常输出', () => {
    const result = formatOutput(baseOptions)
    expect(result.isError).toBe(false)
    expect(result.content).toContain('hello world')
  })

  it('有 stderr 时单独展示', () => {
    const result = formatOutput({ ...baseOptions, stderr: 'warning: something' })
    expect(result.content).toContain('<stderr>')
    expect(result.content).toContain('warning: something')
  })

  it('语义错误时设置 isError', () => {
    const result = formatOutput({ ...baseOptions, exitCode: 1, isSemanticError: true })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Exit code: 1')
  })

  it('超时时设置 isError 并包含提示', () => {
    const result = formatOutput({
      ...baseOptions,
      exitCode: 124,
      timedOut: true,
      durationMs: 30000,
    })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('超时')
    expect(result.content).toContain('30000ms')
  })

  it('中止时设置 isError 并包含提示', () => {
    const result = formatOutput({ ...baseOptions, exitCode: 130, aborted: true })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('中止')
  })

  it('空输出时显示提示', () => {
    const result = formatOutput({ ...baseOptions, stdout: '', stderr: '' })
    expect(result.content).toContain('无输出')
  })

  it('过滤掉 cwd 标记行', () => {
    const result = formatOutput({
      ...baseOptions,
      stdout: `hello\n${CWD_MARKER}=/tmp/test\nworld`,
    })
    expect(result.content).not.toContain(CWD_MARKER)
    expect(result.content).toContain('hello')
    expect(result.content).toContain('world')
  })
})

describe('extractCwdFromOutput', () => {
  it('提取 cwd 标记', () => {
    const stdout = `some output\n${CWD_MARKER}=/Users/test/project\nmore output`
    expect(extractCwdFromOutput(stdout)).toBe('/Users/test/project')
  })

  it('取最后一个标记（多次 cd）', () => {
    const stdout = `${CWD_MARKER}=/Users/test\n${CWD_MARKER}=/Users/test/sub`
    expect(extractCwdFromOutput(stdout)).toBe('/Users/test/sub')
  })

  it('无标记时返回 null', () => {
    expect(extractCwdFromOutput('normal output')).toBeNull()
    expect(extractCwdFromOutput('')).toBeNull()
  })
})

describe('commandContainsCd', () => {
  it('识别 cd 命令', () => {
    expect(commandContainsCd('cd /tmp')).toBe(true)
    expect(commandContainsCd('cd')).toBe(true)
    expect(commandContainsCd('ls && cd /tmp && pwd')).toBe(true)
    expect(commandContainsCd('ls; cd /tmp')).toBe(true)
  })

  it('不误判包含 cd 的其他命令', () => {
    expect(commandContainsCd('echo cdrom')).toBe(false)
    expect(commandContainsCd('ls /cdroms')).toBe(false)
  })

  it('不包含 cd 时返回 false', () => {
    expect(commandContainsCd('ls -la')).toBe(false)
    expect(commandContainsCd('git status')).toBe(false)
  })
})

describe('wrapCommandForCwdDetection', () => {
  it('在命令后追加 cwd 探测', () => {
    const wrapped = wrapCommandForCwdDetection('cd /tmp')
    expect(wrapped).toContain('cd /tmp')
    expect(wrapped).toContain(CWD_MARKER)
    expect(wrapped).toContain('$(pwd)')
  })
})
