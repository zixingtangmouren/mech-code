# Tool 协议设计

## 设计目标

将工具从"名称 + 参数 + 执行函数"的简单 RPC stub，提升为**自描述的能力单元**。每个工具不仅知道怎么执行，还能声明自身属性、动态生成提示词、校验输入合法性。

核心原则：**工具只声明事实，不做策略决策**。权限判定、重试、限流等策略性逻辑由中间件层处理。

---

## 类型定义

### ToolFlags — 工具固有属性

```typescript
interface ToolFlags {
  /** 工具是否只读（无副作用）。只读工具可被调度层安全地自动放行 */
  readonly: boolean
  /** 是否可安全并行执行（多次同时调用不会产生竞态） */
  parallelSafe: boolean
}
```

flags 的消费者是 Agent Loop 和中间件：

- `readonly: true` → 中间件权限策略可跳过用户确认
- `parallelSafe: true` → Loop 调度器可将多个 tool_use 并发执行

### ToolPromptContext — 提示词生成上下文

```typescript
interface ToolPromptContext {
  /** 当前工作目录 */
  cwd: string
  /** 当前可用的其他工具名列表 */
  availableTools: string[]
  /** Agent 当前 turn 序号 */
  turnIndex: number
  /** 共享持久状态 */
  store: Record<string, unknown>
}
```

### ToolExecContext — 执行上下文

```typescript
interface ToolExecContext {
  /** 当前工作目录 */
  cwd: string
  /** 中止信号 */
  signal: AbortSignal
  /** 共享持久状态（session 状态、环境变量等） */
  store: Record<string, unknown>
}
```

### ToolOutput — 工具执行输出

```typescript
interface ToolOutput {
  /** 返回给 LLM 的文本内容 */
  content: string
  /** 是否为错误结果（影响 Loop 的重试/终止逻辑） */
  isError?: boolean
  /** 附加结构化数据，不发给 LLM，供中间件和事件系统消费 */
  metadata?: Record<string, unknown>
}
```

### ValidationResult — 输入校验结果

```typescript
interface ValidationResult {
  valid: boolean
  /** 校验失败时的错误描述 */
  error?: string
}
```

---

## Tool 完整接口

```typescript
interface Tool {
  // === 静态元数据 ===
  name: string
  description: string
  inputSchema: Record<string, unknown>
  flags: ToolFlags

  // === 动态行为 ===

  /**
   * 提示词函数 —— 生成注入 system prompt 的工具说明。
   * 根据运行时上下文（cwd、其他工具、turn 进度）动态调整描述。
   * 返回 null 表示使用静态 description。
   */
  getPrompt(context: ToolPromptContext): string | null

  /**
   * 输入校验 —— 在执行前校验输入合法性。
   * 超越 JSON Schema 的业务级约束（路径安全、参数互斥、资源存在性等）。
   */
  validateInput(input: Record<string, unknown>): ValidationResult | Promise<ValidationResult>

  /**
   * 执行实现
   */
  execute(input: Record<string, unknown>, context: ToolExecContext): Promise<ToolOutput>
}
```

---

## ToolDefinition — 发送给 LLM 的精简视图

```typescript
interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}
```

`ToolDefinition` 是 `Tool` 在 LLM API 层面的投影——Provider 序列化请求时只需要这三个字段。通过 `toDefinition()` 方法或工具注册表导出。

---

## 设计详解

### 1. getPrompt() — 动态提示词

静态 `description` 在注册时确定，无法反映运行时状态。`getPrompt()` 解决以下场景：

| 场景                   | 静态 description  | getPrompt()                                                |
| ---------------------- | ----------------- | ---------------------------------------------------------- |
| read_file 列出可用文件 | "读取文件内容"    | "读取文件内容。当前目录包含：src/, docs/, package.json..." |
| bash 适配操作系统      | "执行 shell 命令" | "执行 shell 命令（当前环境: macOS, zsh）"                  |
| 工具间协作说明         | 无                | "搜索后用 read_file 查看完整内容"                          |
| Token 预算紧张时       | 完整描述          | 返回 null，降级为短 description                            |

**调用时机**：构建 system prompt 阶段（非 Loop 执行阶段），每轮调用一次。

### 2. validateInput() — 输入校验

与 `inputSchema`（JSON Schema 结构校验）互补，处理运行时业务约束：

```typescript
// read_file 的 validateInput 示例
validateInput(input) {
  const path = input.path as string
  if (path.includes('..')) {
    return { valid: false, error: '路径不允许包含 ..' }
  }
  if (path.startsWith('/')) {
    return { valid: false, error: '只允许相对路径' }
  }
  return { valid: true }
}
```

**判断标准**：如果一条校验规则不管在什么环境/策略下都应该生效，那它属于 `validateInput`；如果会随环境变化，那属于中间件。

### 3. flags — 能力声明

flags 是工具作者对工具固有特性的断言，不是可配置项：

```typescript
// grep_search: 只读 + 并行安全
flags: { readonly: true, parallelSafe: true }

// write_file: 有副作用 + 并行不安全（可能写同一文件）
flags: { readonly: false, parallelSafe: false }

// bash: 有副作用 + 并行安全（不同命令互不干扰）
flags: { readonly: false, parallelSafe: true }
```

### 4. ToolOutput — 结构化输出

工具返回值不是裸字符串，而是带语义的结构：

```typescript
// 正常结果
{ content: "文件内容: ...", isError: false }

// 执行失败
{ content: "文件不存在: foo.ts", isError: true }

// 带元数据（供中间件消费，不发给 LLM）
{
  content: "已写入 src/index.ts (42 行)",
  metadata: { bytesWritten: 1024, linesChanged: 42 }
}
```

`isError` 字段让 Agent Loop 区分"工具正常返回了错误信息"和"工具执行本身失败"，便于决定是否需要重试或终止。

---

## Agent Loop 中的工具调用流程

```
LLM 返回 tool_use block
        │
        ▼
┌─ inputSchema 结构校验 (JSON Schema) ─┐
│   失败 → 组装 error ToolOutput       │
└───────────────────────────────────────┘
        │ 通过
        ▼
┌─ tool.validateInput() ───────────────┐
│   失败 → 组装 error ToolOutput       │
└───────────────────────────────────────┘
        │ 通过
        ▼
┌─ middleware.beforeToolExec() ────────┐
│   权限检查、日志、限流等策略         │
│   可设置 skipExecution / overrideResult │
└───────────────────────────────────────┘
        │ 未跳过
        ▼
┌─ tool.execute(input, ctx) ───────────┐
│   实际执行工具逻辑                   │
└───────────────────────────────────────┘
        │
        ▼
┌─ middleware.afterToolExec() ─────────┐
│   修改输出、记录指标等               │
└───────────────────────────────────────┘
        │
        ▼
  组装 tool message → 追加到 messages
```

---

## 并发调度策略

当 LLM 一次返回多个 tool_use block 时，Loop 根据 flags 决定调度方式：

```
多个 tool_use blocks
        │
        ▼
  所有工具均 parallelSafe?
     ├── 是 → Promise.all() 并发执行
     └── 否 → 按顺序串行执行（或仅并发 parallelSafe 的子集）
```

---

## 关于权限

工具协议**不包含**权限判定逻辑。权限是策略性决策，属于中间件层的职责。

工具通过 `flags.readonly` 提供事实依据，权限中间件基于此（加上工具名、输入内容、运行环境等）做出 allow / confirm / deny 决策。这保证了：

- 工具定义与部署策略解耦
- 权限策略可插拔替换（开发模式全放行、生产模式严格确认）
- 不同用户/场景可应用不同权限规则而无需修改工具代码

---

## 与 MCP 工具的关系

MCP（Model Context Protocol）服务器提供的远程工具同样遵循此协议。MCP Client 获取远程工具 schema 后，包装为本地 `Tool` 实例：

```typescript
// MCP 工具的 flags 默认保守
flags: { readonly: false, parallelSafe: false }

// MCP 工具的 validateInput 只做基础校验（实际校验在远端）
validateInput: () => ({ valid: true })

// MCP 工具的 getPrompt 直接返回远端提供的 description
getPrompt: () => null

// execute 通过 MCP Client 转发
execute: (input, ctx) => mcpClient.callTool(name, input, ctx.signal)
```

MCP 服务器可通过扩展协议声明 flags（如 `x-readonly: true`），MCP Client 识别后填充到本地工具实例。
