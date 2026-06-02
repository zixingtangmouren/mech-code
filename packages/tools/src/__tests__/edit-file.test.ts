import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { writeFile, mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { editFileTool } from '../edit-file.js'
import type { ToolRunContext, ReadCacheEntry } from '@mech-code/core'

// 测试用临时目录
let testDir: string
let ctx: ToolRunContext
let readFileState: Map<string, ReadCacheEntry>

beforeEach(async () => {
  testDir = join(tmpdir(), `edit-file-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(testDir, { recursive: true })
  readFileState = new Map()
  ctx = {
    cwd: testDir,
    signal: new AbortController().signal,
    metadata: { __readFileState: readFileState },
  }
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

/** 创建测试文件并注册到 readFileState */
async function createTestFile(name: string, content: string) {
  const filePath = join(testDir, name)
  await writeFile(filePath, content, 'utf-8')
  const stats = await stat(filePath)
  readFileState.set(filePath, {
    timestamp: Math.floor(stats.mtimeMs),
    offset: undefined,
    limit: undefined,
    content,
  })
  return filePath
}

describe('edit_file', () => {
  describe('基础替换', () => {
    it('精确匹配并替换单次出现', async () => {
      await createTestFile('test.ts', 'const a = 1\nconst b = 2\n')
      const result = await editFileTool.execute(
        {
          path: 'test.ts',
          old_string: 'const a = 1',
          new_string: 'const a = 42',
          replace_all: false,
        },
        ctx,
      )
      expect(result.isError).toBeUndefined()
      expect(result.content).toContain('已编辑')
    })

    it('未找到匹配时返回错误并提供诊断', async () => {
      await createTestFile('test.ts', 'const a = 1\nconst b = 2\n')
      const result = await editFileTool.execute(
        { path: 'test.ts', old_string: 'const c = 3', new_string: 'x', replace_all: false },
        ctx,
      )
      expect(result.isError).toBe(true)
      expect(result.content).toContain('未找到')
    })

    it('多次匹配且 replace_all=false 时报错', async () => {
      await createTestFile('test.ts', 'foo\nfoo\nfoo\n')
      const result = await editFileTool.execute(
        { path: 'test.ts', old_string: 'foo', new_string: 'bar', replace_all: false },
        ctx,
      )
      expect(result.isError).toBe(true)
      expect(result.content).toContain('3 次')
    })
  })

  describe('replace_all', () => {
    it('替换所有出现', async () => {
      const filePath = await createTestFile('test.ts', 'foo\nfoo\nfoo\n')
      const result = await editFileTool.execute(
        { path: 'test.ts', old_string: 'foo', new_string: 'bar', replace_all: true },
        ctx,
      )
      expect(result.isError).toBeUndefined()
      expect(result.content).toContain('3 处匹配')

      // 验证缓存内容已更新
      const cached = readFileState.get(filePath)
      expect(cached?.content).toBe('bar\nbar\nbar\n')
    })
  })

  describe('创建新文件（old_string 为空）', () => {
    it('文件不存在时创建', async () => {
      const result = await editFileTool.execute(
        { path: 'new-file.ts', old_string: '', new_string: 'hello world', replace_all: false },
        ctx,
      )
      expect(result.isError).toBeUndefined()
      expect(result.content).toContain('已创建')
    })

    it('文件存在且有内容时拒绝', async () => {
      await createTestFile('existing.ts', 'some content')
      const result = await editFileTool.execute(
        { path: 'existing.ts', old_string: '', new_string: 'overwrite', replace_all: false },
        ctx,
      )
      expect(result.isError).toBe(true)
      expect(result.content).toContain('已存在且有内容')
    })

    it('文件存在但为空时允许写入', async () => {
      await createTestFile('empty.ts', '')
      const result = await editFileTool.execute(
        { path: 'empty.ts', old_string: '', new_string: 'new content', replace_all: false },
        ctx,
      )
      expect(result.isError).toBeUndefined()
      expect(result.content).toContain('已编辑')
    })

    it('自动创建中间目录', async () => {
      const result = await editFileTool.execute(
        {
          path: 'deep/nested/dir/file.ts',
          old_string: '',
          new_string: 'content',
          replace_all: false,
        },
        ctx,
      )
      expect(result.isError).toBeUndefined()
      expect(result.content).toContain('已创建')
    })
  })

  describe('读前置校验', () => {
    it('文件未被读取过时拒绝编辑', async () => {
      // 直接创建文件但不注册到 readFileState
      await writeFile(join(testDir, 'unread.ts'), 'content', 'utf-8')
      const result = await editFileTool.execute(
        { path: 'unread.ts', old_string: 'content', new_string: 'new', replace_all: false },
        ctx,
      )
      expect(result.isError).toBe(true)
      expect(result.content).toContain('尚未被读取')
    })

    it('无 readFileState 时跳过校验（向后兼容）', async () => {
      await writeFile(join(testDir, 'test.ts'), 'hello', 'utf-8')
      const ctxNoState: ToolRunContext = {
        cwd: testDir,
        signal: new AbortController().signal,
        metadata: {},
      }
      const result = await editFileTool.execute(
        { path: 'test.ts', old_string: 'hello', new_string: 'world', replace_all: false },
        ctxNoState,
      )
      expect(result.isError).toBeUndefined()
      expect(result.content).toContain('已编辑')
    })
  })

  describe('时间戳校验', () => {
    it('文件被外部修改后拒绝编辑（无 content 缓存）', async () => {
      const filePath = join(testDir, 'modified.ts')
      await writeFile(filePath, 'original', 'utf-8')

      // 注册一个过时的 timestamp（不带 content）
      readFileState.set(filePath, {
        timestamp: 0, // 很久以前
        offset: undefined,
        limit: undefined,
      })

      const result = await editFileTool.execute(
        { path: 'modified.ts', old_string: 'original', new_string: 'changed', replace_all: false },
        ctx,
      )
      expect(result.isError).toBe(true)
      expect(result.content).toContain('已被外部修改')
    })

    it('mtime 变化但内容未变时允许编辑（content 兜底）', async () => {
      const filePath = join(testDir, 'touched.ts')
      await writeFile(filePath, 'unchanged content', 'utf-8')

      // 注册过时 timestamp 但带正确 content
      readFileState.set(filePath, {
        timestamp: 0, // 过时
        offset: undefined,
        limit: undefined,
        content: 'unchanged content',
      })

      const result = await editFileTool.execute(
        { path: 'touched.ts', old_string: 'unchanged', new_string: 'changed', replace_all: false },
        ctx,
      )
      expect(result.isError).toBeUndefined()
      expect(result.content).toContain('已编辑')
    })
  })

  describe('编辑后 readFileState 更新', () => {
    it('编辑成功后更新缓存', async () => {
      const filePath = await createTestFile('test.ts', 'const x = 1')
      await editFileTool.execute(
        {
          path: 'test.ts',
          old_string: 'const x = 1',
          new_string: 'const x = 2',
          replace_all: false,
        },
        ctx,
      )
      const cached = readFileState.get(filePath)
      expect(cached).toBeDefined()
      expect(cached!.content).toBe('const x = 2')
      expect(cached!.offset).toBeUndefined()
      expect(cached!.limit).toBeUndefined()
    })
  })

  describe('validateInput', () => {
    it('old_string === new_string 时拒绝', async () => {
      const result = await editFileTool.validateInput({
        path: 'test.ts',
        old_string: 'same',
        new_string: 'same',
        replace_all: false,
      })
      expect(result.valid).toBe(false)
      expect(result.error).toContain('相同')
    })

    it('old_string 为空时 old===new 不触发（允许创建空文件）', async () => {
      const result = await editFileTool.validateInput({
        path: 'test.ts',
        old_string: '',
        new_string: '',
        replace_all: false,
      })
      expect(result.valid).toBe(true)
    })

    it('危险设备路径被拦截', async () => {
      const result = await editFileTool.validateInput({
        path: '/dev/zero',
        old_string: 'x',
        new_string: 'y',
        replace_all: false,
      })
      expect(result.valid).toBe(false)
      expect(result.error).toContain('设备文件')
    })
  })

  describe('诊断信息', () => {
    it('多行 old_string 部分匹配时给出行号诊断', async () => {
      await createTestFile('test.ts', 'line1\nline2\nline3\n')
      const result = await editFileTool.execute(
        {
          path: 'test.ts',
          old_string: 'line1\nline2\nwrong',
          new_string: 'x',
          replace_all: false,
        },
        ctx,
      )
      expect(result.isError).toBe(true)
      expect(result.content).toContain('前 2 行可以匹配')
    })
  })

  describe('路径处理', () => {
    it('文件不存在时给出 fuzzy 建议', async () => {
      await createTestFile('index.ts', 'content')
      const result = await editFileTool.execute(
        { path: 'indx.ts', old_string: 'content', new_string: 'x', replace_all: false },
        ctx,
      )
      expect(result.isError).toBe(true)
      expect(result.content).toContain('不存在')
    })

    it('支持 ~ 展开的路径', async () => {
      // validateInput 不应对 ~ 路径报错
      const result = await editFileTool.validateInput({
        path: '~/some/file.ts',
        old_string: 'x',
        new_string: 'y',
        replace_all: false,
      })
      expect(result).toEqual({ valid: true })
    })
  })

  describe('getPrompt', () => {
    it('返回包含 cwd 的提示词', () => {
      const prompt = editFileTool.getPrompt({
        cwd: '/workspace',
        availableTools: ['read_file', 'edit_file'],
        turnIndex: 1,
        metadata: {},
      })
      expect(prompt).toContain('/workspace')
      expect(prompt).toContain('read_file')
    })
  })

  // === Phase 2 测试 ===

  describe('引号标准化匹配', () => {
    it('文件含弯双引号时，用直双引号也能匹配', async () => {
      // \u201c \u201d 是弯双引号
      await createTestFile('curly.txt', 'He said \u201chello\u201d to her.\n')
      const result = await editFileTool.execute(
        {
          path: 'curly.txt',
          old_string: 'He said "hello" to her.',
          new_string: 'He said "world" to her.',
          replace_all: false,
        },
        ctx,
      )
      expect(result.isError).toBeUndefined()
      expect(result.content).toContain('已编辑')
    })

    it('文件含弯单引号时，用直单引号也能匹配', async () => {
      // \u2018 \u2019 是弯单引号
      await createTestFile('single.txt', 'It\u2019s a \u2018test\u2019 file.\n')
      const result = await editFileTool.execute(
        {
          path: 'single.txt',
          old_string: "It's a 'test' file.",
          new_string: "It's a 'demo' file.",
          replace_all: false,
        },
        ctx,
      )
      expect(result.isError).toBeUndefined()
      expect(result.content).toContain('已编辑')
    })

    it('精确匹配优先于引号标准化', async () => {
      // 文件同时包含直引号和弯引号，应优先匹配直引号
      await createTestFile('mixed.txt', 'say "hi" and \u201cbye\u201d\n')
      const result = await editFileTool.execute(
        {
          path: 'mixed.txt',
          old_string: 'say "hi"',
          new_string: 'say "hello"',
          replace_all: false,
        },
        ctx,
      )
      expect(result.isError).toBeUndefined()
    })
  })

  describe('preserveQuoteStyle', () => {
    it('替换时保持文件的弯引号风格', async () => {
      const filePath = await createTestFile('preserve.txt', 'title: \u201cOld Title\u201d\n')
      await editFileTool.execute(
        {
          path: 'preserve.txt',
          old_string: 'title: "Old Title"',
          new_string: 'title: "New Title"',
          replace_all: false,
        },
        ctx,
      )
      const cached = readFileState.get(filePath)
      // new_string 中的直引号应被转为弯引号
      expect(cached?.content).toBe('title: \u201cNew Title\u201d\n')
    })

    it('缩略词中的撇号保持为右弯单引号', async () => {
      const filePath = await createTestFile(
        'apostrophe.txt',
        'He said \u201cdon\u2019t worry\u201d\n',
      )
      await editFileTool.execute(
        {
          path: 'apostrophe.txt',
          old_string: 'He said "don\'t worry"',
          new_string: 'He said "don\'t panic"',
          replace_all: false,
        },
        ctx,
      )
      const cached = readFileState.get(filePath)
      expect(cached?.content).toBe('He said \u201cdon\u2019t panic\u201d\n')
    })
  })

  describe('删除时尾随换行清理', () => {
    it('删除一行时连同尾随换行一起删除', async () => {
      const filePath = await createTestFile('trail.ts', 'line1\nline2\nline3\n')
      await editFileTool.execute(
        { path: 'trail.ts', old_string: 'line2', new_string: '', replace_all: false },
        ctx,
      )
      const cached = readFileState.get(filePath)
      expect(cached?.content).toBe('line1\nline3\n')
    })

    it('old_string 本身以换行结尾时不额外删除', async () => {
      const filePath = await createTestFile('trail2.ts', 'line1\nline2\nline3\n')
      await editFileTool.execute(
        { path: 'trail2.ts', old_string: 'line2\n', new_string: '', replace_all: false },
        ctx,
      )
      const cached = readFileState.get(filePath)
      expect(cached?.content).toBe('line1\nline3\n')
    })

    it('最后一行删除时不会越界', async () => {
      const filePath = await createTestFile('trail3.ts', 'line1\nline2')
      await editFileTool.execute(
        { path: 'trail3.ts', old_string: 'line2', new_string: '', replace_all: false },
        ctx,
      )
      const cached = readFileState.get(filePath)
      // 最后一行后面没有换行，不会删多
      expect(cached?.content).toBe('line1\n')
    })

    it('非删除模式不触发尾随换行清理', async () => {
      const filePath = await createTestFile('trail4.ts', 'aaa\nbbb\nccc\n')
      await editFileTool.execute(
        { path: 'trail4.ts', old_string: 'bbb', new_string: 'xxx', replace_all: false },
        ctx,
      )
      const cached = readFileState.get(filePath)
      expect(cached?.content).toBe('aaa\nxxx\nccc\n')
    })
  })
})
