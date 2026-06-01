# Read File Tool 设计

## 背景

当前 `read_file` 工具实现过于简单——仅做文件读取 + 行范围截取，缺乏大小防护、格式支持、智能提示等关键能力。参考 Claude Code 的 `FileReadTool` 设计，本文档规划 `read_file` 的完整升级方案。

---

## 设计目标

1. **安全**：防止大文件打爆上下文窗口，拦截二进制/危险路径
2. **高效**：加行号辅助 LLM 精确引用，重复读取去重节省 token
3. **多模态**：统一入口支持文本、图片、PDF 等格式
4. **友好**：文件不存在时提供模糊建议，路径支持 `~` 展开

---

## 参数设计

```typescript
const inputSchema = z.object({
  /** 文件路径（相对 cwd 或绝对路径，支持 ~ 展开） */
  path: z.string().min(1),
  /**
   * 起始行偏移（1-based）。
   * 仅在文件过大需要分段读取时提供。
   */
  offset: z.number().int().min(1).optional(),
  /**
   * 读取行数上限。
   * 与 offset 配合实现分段读取。
   */
  limit: z.number().int().min(1).optional(),
})
```

### 与当前 `startLine + endLine` 的变更说明

改为 `offset + limit` 模式，原因：

- 更贴合 LLM 的使用心智模型（"从第 100 行开始读 50 行" vs "读 100-149 行"）
- prompt 可引导 LLM 默认不传参（整文件读取），只在收到"文件太大"错误后才使用分段
- 避免 `endLine < startLine` 等非法状态

---

## 输出格式

### 文本文件

返回内容带行号前缀（`cat -n` 格式），便于 LLM 精确引用：

```
[path/to/file.ts] lines 1-50 of 200

     1	import { foo } from './bar.js'
     2
     3	export function hello() {
     4	  return 'world'
     5	}
```

### 输出结构（TypeScript）

```typescript
/** 文本文件输出 */
interface TextOutput {
  type: 'text'
  content: string // 带行号的文件内容
  numLines: number // 返回的行数
  startLine: number // 起始行号
  totalLines: number // 文件总行数
}

/** 图片文件输出 */
interface ImageOutput {
  type: 'image'
  base64: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  originalSize: number // 原始文件字节数
}

/** 重复读取输出 */
interface UnchangedOutput {
  type: 'file_unchanged'
  message: string // 提示 LLM 参考之前的读取结果
}

type ReadFileOutput = TextOutput | ImageOutput | UnchangedOutput
```

实际返回给 LLM 的仍是 `ToolOutput.content` 字符串，结构化类型用于内部处理和事件分发。

---

## 核心机制

### 1. 双层大小限制

| 限制           | 默认值 | 检查时机         | 超限行为                        |
| -------------- | ------ | ---------------- | ------------------------------- |
| `maxSizeBytes` | 256 KB | 读取前（`stat`） | 直接报错，建议使用 offset+limit |
| `maxTokens`    | 16000  | 读取后（粗估）   | 报错，告知预估 token 数         |

#### maxSizeBytes 预检

```typescript
const stats = await stat(filePath)
if (stats.size > maxSizeBytes) {
  return {
    content:
      `文件过大 (${formatSize(stats.size)})，超出 ${formatSize(maxSizeBytes)} 限制。` +
      `请使用 offset 和 limit 参数分段读取。文件共 ${totalLines} 行。`,
    isError: true,
  }
}
```

#### maxTokens 粗估

读取完成后，使用 `content.length / 4` 粗略估算 token 数（英文为主的代码文件一般 1 token ≈ 4 chars）。超限则报错并建议缩小范围。

```typescript
const estimatedTokens = Math.ceil(content.length / 4)
if (estimatedTokens > maxTokens) {
  return {
    content:
      `文件内容约 ${estimatedTokens} tokens，超出 ${maxTokens} 上限。` +
      `请使用 offset + limit 缩小读取范围。`,
    isError: true,
  }
}
```

### 2. 行号格式化

```typescript
function addLineNumbers(content: string, startLine: number): string {
  const lines = content.split('\n')
  const maxLineNo = startLine + lines.length - 1
  const width = String(maxLineNo).length
  return lines.map((line, i) => `${String(startLine + i).padStart(width)}\t${line}`).join('\n')
}
```

### 3. 二进制文件拦截

在执行前通过扩展名判断，拒绝已知二进制格式（排除图片）：

```typescript
const BINARY_EXTENSIONS = new Set([
  'exe',
  'dll',
  'so',
  'dylib',
  'bin',
  'obj',
  'o',
  'a',
  'zip',
  'tar',
  'gz',
  'bz2',
  'xz',
  '7z',
  'rar',
  'wasm',
  'class',
  'pyc',
  'pyd',
  'db',
  'sqlite',
  'sqlite3',
  'ico',
  'ttf',
  'otf',
  'woff',
  'woff2',
  'eot',
])

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])
```

### 4. 路径处理

#### ~ 展开

```typescript
function expandPath(filePath: string): string {
  if (filePath.startsWith('~/') || filePath === '~') {
    return filePath.replace('~', homedir())
  }
  return filePath
}
```

#### 文件不存在时模糊建议

当 `ENOENT` 时，扫描同目录下的文件，用编辑距离找到最接近的路径：

```typescript
// 伪代码
const dir = dirname(filePath)
const base = basename(filePath)
const entries = await readdir(dir)
const similar = entries
  .map((e) => ({ name: e, dist: levenshtein(base, e) }))
  .filter((e) => e.dist <= 3)
  .sort((a, b) => a.dist - b.dist)

if (similar.length > 0) {
  message += ` 你是否指的是 ${join(dir, similar[0].name)}？`
}
```

### 5. 重复读取去重

在 `ToolExecContext` 中维护一个 `readFileState: Map<string, ReadCacheEntry>`：

```typescript
interface ReadCacheEntry {
  /** 文件读取时的 mtime（毫秒） */
  timestamp: number
  /** 上次读取的 offset */
  offset?: number
  /** 上次读取的 limit */
  limit?: number
}
```

去重逻辑：

```typescript
const cached = ctx.readFileState?.get(filePath)
if (cached && cached.offset === offset && cached.limit === limit) {
  const currentMtime = (await stat(filePath)).mtimeMs
  if (currentMtime === cached.timestamp) {
    return {
      content: '文件自上次读取后未发生变化，请参考之前的读取结果。',
    }
  }
}
```

**注意**：去重状态需要在 Agent Loop 层维护，跨 turn 共享。可通过 `ToolExecContext.metadata` 传入，或扩展 `ToolExecContext` 接口。

### 6. 图片读取

支持的格式：`png`, `jpg`, `jpeg`, `gif`, `webp`

流程：

1. 检测扩展名为图片格式
2. 读取文件为 Buffer
3. 若文件过大（> 1MB），进行压缩/缩放
4. 转 base64 返回

```typescript
if (IMAGE_EXTENSIONS.has(ext)) {
  const buffer = await readFile(filePath)
  // 可选：大图压缩（依赖 sharp，作为可选 peer dependency）
  const base64 = buffer.toString('base64')
  const mediaType = `image/${ext === 'jpg' ? 'jpeg' : ext}`
  return {
    content: `[图片文件: ${basename(filePath)}, ${formatSize(buffer.length)}]`,
    metadata: {
      type: 'image',
      base64,
      mediaType,
      originalSize: buffer.length,
    },
  }
}
```

> 图片数据通过 `metadata` 传递给 provider 层，由 provider 负责转换为对应 API 的 multimodal 格式（如 Anthropic 的 image content block）。具体的 provider 适配不在本 tool 实现范围内。

---

## Prompt 动态生成

`read_file` 应实现 `getPrompt()` 根据运行时上下文生成更精准的 tool description：

```typescript
getPrompt(ctx: ToolPromptContext): string {
  return `读取本地文件系统中的文件内容。

使用说明：
- path 参数支持绝对路径或相对于工作目录（${ctx.cwd}）的相对路径
- 默认读取整个文件（上限 ${MAX_LINES} 行）
- 文件过大时会返回错误提示，此时请使用 offset 和 limit 参数分段读取
- 返回内容带有行号前缀，格式类似 cat -n
- 支持读取图片文件（png/jpg/gif/webp），内容将以视觉方式呈现
- 不支持读取二进制文件（可执行文件、压缩包等）
- 若文件不存在会尝试建议相近的文件名`
}
```

---

## validateInput 实现

```typescript
async validateInput(input: { path: string; offset?: number; limit?: number }): Promise<ValidationResult> {
  const filePath = expandPath(resolve(cwd, input.path))

  // 1. 二进制扩展名检查
  const ext = extname(filePath).slice(1).toLowerCase()
  if (BINARY_EXTENSIONS.has(ext)) {
    return { valid: false, error: `不支持读取二进制文件 (.${ext})。` }
  }

  // 2. 危险设备路径拦截
  if (BLOCKED_DEVICE_PATHS.has(filePath)) {
    return { valid: false, error: `无法读取设备文件 ${input.path}，该路径会导致阻塞或无限输出。` }
  }

  // 3. offset/limit 合理性
  if (input.offset !== undefined && input.limit !== undefined) {
    // 合法，无需额外检查
  }

  return { valid: true }
}
```

---

## 危险设备路径黑名单

```typescript
const BLOCKED_DEVICE_PATHS = new Set([
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/full',
  '/dev/stdin',
  '/dev/tty',
  '/dev/console',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/fd/0',
  '/dev/fd/1',
  '/dev/fd/2',
])
```

---

## 配置项

通过 `AgentConfig` 或工具注册时传入：

```typescript
interface ReadFileConfig {
  /** 单次读取最大字节数，默认 256KB */
  maxSizeBytes?: number
  /** 单次读取最大 token 数（粗估），默认 16000 */
  maxTokens?: number
  /** 默认最大读取行数（不传 limit 时），默认 2000 */
  maxLines?: number
  /** 是否启用重复读取去重，默认 true */
  enableDedup?: boolean
  /** 是否启用图片读取，默认 true */
  enableImageRead?: boolean
}
```

---

## 实现计划

### Phase 1 — 安全防护与基本体验

- [ ] maxSizeBytes 预检（stat 后判断）
- [ ] maxTokens 粗估检查
- [ ] 行号格式化输出（`cat -n` 风格）
- [ ] 参数改为 `offset + limit`（保持向后兼容：同时接受旧 `startLine/endLine`）
- [ ] 二进制扩展名前置拦截
- [ ] 危险设备路径黑名单
- [ ] 路径 `~` 展开

### Phase 2 — 智能提示与去重

- [ ] 文件不存在时 fuzzy 建议（Levenshtein 距离）
- [ ] 重复读取去重（扩展 ToolExecContext，新增 readFileState）
- [ ] 动态 prompt 生成（getPrompt）
- [ ] validateInput 完整实现

### Phase 3 — 多模态支持

- [ ] 图片文件读取（base64 + metadata）
- [ ] Provider 层适配图片 content block
- [ ] 大图压缩（可选依赖 sharp）
- [ ] PDF 支持（可选，优先级低）

---

## 与现有架构的交互

### ToolExecContext 扩展

去重功能需要跨 turn 状态，需在 `ToolExecContext` 中新增：

```typescript
interface ToolExecContext {
  cwd: string
  signal: AbortSignal
  metadata: Record<string, unknown>
  /** 文件读取状态缓存，用于去重（由 Agent Loop 维护） */
  readFileState?: Map<string, ReadCacheEntry>
}
```

### Provider 层配合

图片输出需要 provider 将 `metadata.type === 'image'` 的 tool result 转换为对应 API 格式：

- **Anthropic**：`{ type: 'image', source: { type: 'base64', data, media_type } }`
- **OpenAI**：目前 tool result 不支持 image，需将图片作为 user message 注入（或降级为文本描述）

这部分改造属于 provider/serializer 层，不在 tool 本身实现范围内，但需要在 `ToolOutput` 的 `metadata` 中约定好数据格式。

---

## 参考

- Claude Code `FileReadTool`：多格式统一入口、双层限制、dedup、fuzzy suggest
- 现有 `04-tool-protocol.md`：Tool 接口规范
