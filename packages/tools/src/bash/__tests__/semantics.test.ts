import { describe, it, expect } from 'vitest'
import { isCommandError, extractBaseCommand, getExitCodeSemantics } from '../semantics.js'

describe('extractBaseCommand', () => {
  it('提取普通命令名', () => {
    expect(extractBaseCommand('grep -r foo .')).toBe('grep')
    expect(extractBaseCommand('ls -la')).toBe('ls')
    expect(extractBaseCommand('git diff HEAD')).toBe('git')
  })

  it('跳过环境变量前缀', () => {
    expect(extractBaseCommand('FOO=bar npm run test')).toBe('npm')
    expect(extractBaseCommand('NODE_ENV=production node app.js')).toBe('node')
  })

  it('取管道第一段的命令', () => {
    expect(extractBaseCommand('cat file.txt | grep pattern')).toBe('cat')
    expect(extractBaseCommand('find . -name "*.ts" | wc -l')).toBe('find')
  })

  it('取绝对路径命令的名称部分', () => {
    expect(extractBaseCommand('/usr/bin/grep pattern file')).toBe('grep')
  })

  it('处理空字符串', () => {
    expect(extractBaseCommand('')).toBe('')
    expect(extractBaseCommand('   ')).toBe('')
  })
})

describe('isCommandError', () => {
  it('默认语义：非 0 退出码为错误', () => {
    expect(isCommandError('ls nonexistent', 1)).toBe(true)
    expect(isCommandError('ls', 0)).toBe(false)
  })

  it('grep：exit 1 为无匹配（非错误）', () => {
    expect(isCommandError('grep pattern file', 0)).toBe(false) // 有匹配
    expect(isCommandError('grep pattern file', 1)).toBe(false) // 无匹配
    expect(isCommandError('grep pattern file', 2)).toBe(true) // 执行错误
  })

  it('rg：exit 1 为无匹配（非错误）', () => {
    expect(isCommandError('rg pattern', 1)).toBe(false)
    expect(isCommandError('rg pattern', 2)).toBe(true)
  })

  it('diff：exit 1 为有差异（非错误）', () => {
    expect(isCommandError('diff file1 file2', 0)).toBe(false) // 相同
    expect(isCommandError('diff file1 file2', 1)).toBe(false) // 有差异
    expect(isCommandError('diff file1 file2', 2)).toBe(true) // 执行错误
  })

  it('find：exit 1 为部分不可达（非错误）', () => {
    expect(isCommandError('find . -name "*.ts"', 1)).toBe(false)
    expect(isCommandError('find . -name "*.ts"', 2)).toBe(true)
  })

  it('test：exit 1 为条件为假（非错误）', () => {
    expect(isCommandError('test -f file', 0)).toBe(false) // 条件真
    expect(isCommandError('test -f file', 1)).toBe(false) // 条件假
    expect(isCommandError('test -f file', 2)).toBe(true) // 语法错误
  })

  it('which：exit 1 为未找到（非错误）', () => {
    expect(isCommandError('which node', 1)).toBe(false)
    expect(isCommandError('which node', 0)).toBe(false)
  })
})

describe('getExitCodeSemantics', () => {
  it('未知命令返回默认语义', () => {
    const fn = getExitCodeSemantics('unknowncommand')
    expect(fn(0)).toBe(false)
    expect(fn(1)).toBe(true)
    expect(fn(127)).toBe(true)
  })

  it('grep 返回特定语义', () => {
    const fn = getExitCodeSemantics('grep')
    expect(fn(0)).toBe(false)
    expect(fn(1)).toBe(false)
    expect(fn(2)).toBe(true)
  })
})
