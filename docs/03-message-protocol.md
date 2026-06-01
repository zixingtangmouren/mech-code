# Message 协议设计文档

> 版本：v0.1.0 · 日期：2026-05-30

---

## 1. 设计原则

- **Message 是 Agent Loop 的通信协议**：所有参与者（用户、LLM、工具）之间的交互通过 Message 进行
- **统一内部表示**：所有厂商的消息格式和流式 chunk，进入 Agent Loop 前必须转换为标准内部 Message 结构
- **Agent Loop 不感知厂商差异**：Provider adapter 负责双向格式转换，Loop Engine 只操作内部类型

---

## 2. 类型设计

### 2.1 对外 Message（SDK 用户传入）

面向 SDK 消费者的简化形式，允许 `string` 快捷写法：

```ts
type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | UserContentBlock[] }
  | { role: 'assistant'; content: string | AssistantContentBlock[] }
  | { role: 'tool'; toolCallId: string; content: string }
```

### 2.2 内部 Message（Agent Loop 运行时）

Agent Loop 内部使用的规范化形式，所有 content 均为数组：

```ts
type InternalMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: UserContentBlock[] }
  | { role: 'assistant'; content: AssistantContentBlock[] }
  | { role: 'tool'; toolCallId: string; content: string }
```

### 2.3 User Content Block

用户消息的内容块，支持多模态：

```ts
type UserContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: ImageSource }
  | { type: 'file'; data: Uint8Array; mediaType: string }

type ImageSource =
  | { type: 'base64'; mediaType: string; data: string }
  | { type: 'url'; url: string }
```

### 2.4 Assistant Content Block

模型回复的内容块。一条 assistant 消息可以同时包含 thinking + text + 多个 tool_use：

```ts
type AssistantContentBlock =
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
```

### 2.5 Tool Message

工具执行结果，通过 `toolCallId` 与 assistant 消息中的 `tool_use.id` 关联：

```ts
{
  role: 'tool'
  toolCallId: string
  content: string
}
```

---

## 3. 消息在 Agent Loop 中的流转

```
用户输入
│
├─ normalize: Message → InternalMessage
│
├─ [Agent Loop]
│   │
│   ├─ 组装请求: InternalMessage[] → Provider serialize → Vendor API Request
│   │
│   ├─ 流式响应: Vendor Chunk → Provider parseStream → StreamEvent
│   │                                                      │
│   │                                             (实时 emit 事件给消费者)
│   │
│   ├─ 响应完成: 累积 StreamEvent → InternalMessage (role: assistant)
│   │
│   ├─ 如果有 tool_use:
│   │   ├─ 执行工具
│   │   ├─ 生成 InternalMessage (role: tool)
│   │   └─ 追加到 messages[] → 回到循环顶部
│   │
│   └─ 无 tool_use → 结束循环
│
├─ 输出: InternalMessage[] → denormalize → Message[]（返回给 SDK 用户）
```

---

## 4. Normalize / Denormalize

### 4.1 Normalize（对外 → 内部）

将用户传入的宽松格式转为内部规范格式：

```ts
function normalizeMessage(msg: Message): InternalMessage

// 转换规则：
// 'hello' → [{ type: 'text', text: 'hello' }]
// string content → 包装为单个 text block 数组
// 已经是数组的 → 直接使用
```

### 4.2 Denormalize（内部 → 对外）

将内部格式转回对外形式（可选，主要用于 RunResult 返回）：

```ts
function denormalizeMessage(msg: InternalMessage): Message

// 转换规则：
// [{ type: 'text', text: 'hello' }] → 可简化为 'hello'（仅单个 text block 时）
// 包含 tool_use / thinking → 保持数组形式
```

---

## 5. Provider Adapter 的 Message 转换职责

### 5.1 请求序列化

将 InternalMessage[] 转换为厂商特定的 API 请求格式：

```ts
interface MessageSerializer {
  serialize(messages: InternalMessage[], options: SerializeOptions): VendorRequest
}

interface SerializeOptions {
  system?: string
  tools?: ToolDefinition[]
  maxTokens?: number
}
```

#### Anthropic 格式

```ts
// InternalMessage
{ role: 'assistant', content: [
  { type: 'text', text: '让我来看看' },
  { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'foo.ts' } }
]}

// → Anthropic API
{ role: 'assistant', content: [
  { type: 'text', text: '让我来看看' },
  { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'foo.ts' } }
]}
// (Anthropic 原生格式与我们的内部格式高度对齐)
```

#### OpenAI 格式

```ts
// InternalMessage
{ role: 'assistant', content: [
  { type: 'text', text: '让我来看看' },
  { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'foo.ts' } }
]}

// → OpenAI API
{
  role: 'assistant',
  content: '让我来看看',
  tool_calls: [{
    id: 'call_1',
    type: 'function',
    function: { name: 'read_file', arguments: '{"path":"foo.ts"}' }
  }]
}
```

### 5.2 流式 Chunk 规范化

将厂商流式响应转换为内部 StreamEvent：

```ts
interface StreamNormalizer {
  /** 逐 chunk 调用，输出标准化事件 */
  push(chunk: VendorChunk): StreamEvent[]
  /** 流结束时调用，输出剩余事件 */
  flush(): StreamEvent[]
}
```

#### Anthropic Stream → Internal StreamEvent

| Anthropic 原始事件                       | 内部 StreamEvent      |
| ---------------------------------------- | --------------------- |
| `content_block_start` (type=thinking)    | `reasoning_start`     |
| `content_block_delta` (thinking_delta)   | `reasoning_content`   |
| `content_block_stop` (thinking block)    | `reasoning_end`       |
| `content_block_start` (type=text)        | `text_start`          |
| `content_block_delta` (text_delta)       | `text_delta`          |
| `content_block_stop` (text block)        | `text_end`            |
| `content_block_start` (type=tool_use)    | `tool_start`          |
| `content_block_delta` (input_json_delta) | `tool_input_delta`    |
| `content_block_stop` (tool_use block)    | (无，等待执行)        |
| `message_delta` (stop_reason)            | (由 Loop Engine 处理) |

#### OpenAI Stream → Internal StreamEvent

| OpenAI 原始事件                                     | 内部 StreamEvent                            |
| --------------------------------------------------- | ------------------------------------------- |
| `choices[0].delta.content` (非空)                   | `text_delta`（首次触发 `text_start`）       |
| `choices[0].delta.tool_calls[i].function.arguments` | `tool_input_delta`（首次触发 `tool_start`） |
| `choices[0].finish_reason = 'stop'`                 | `text_end`                                  |
| `choices[0].finish_reason = 'tool_calls'`           | (由 Loop Engine 处理)                       |

### 5.3 响应累积

流结束后，从 StreamEvent 序列累积生成完整的 InternalMessage：

```ts
function accumulateAssistantMessage(events: StreamEvent[]): InternalMessage

// 逻辑：
// reasoning_start → reasoning_content×N → reasoning_end  ⇒  { type: 'thinking', text }
// text_start → text_delta×N → text_end                   ⇒  { type: 'text', text }
// tool_start → tool_input_delta×N                         ⇒  { type: 'tool_use', id, name, input }
//
// 最终拼装为:
// { role: 'assistant', content: [...blocks] }
```

---

## 6. 模块划分

```
packages/core/src/message/
├── types.ts              # Message / InternalMessage / ContentBlock 类型
├── normalize.ts          # Message ↔ InternalMessage 转换
├── builder.ts            # 组装 messages + system + tools 为请求参数
├── accumulator.ts        # StreamEvent[] → InternalMessage 累积器
└── tokenizer.ts          # Token 计数估算

packages/core/src/provider/
├── types.ts              # LLMProvider / StreamEvent / StreamNormalizer 接口
├── anthropic.ts          # Anthropic 实现（含 serialize + parseStream）
├── openai.ts             # OpenAI 实现
└── openai-compatible.ts  # 通用兼容实现
```

---

## 7. 设计决策记录

| 决策                                | 原因                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 内部 Message 的 content 统一为数组  | assistant 消息天然包含多个 block（thinking + text + tool_use），统一为数组避免条件判断                  |
| 对外 Message 允许 `string` 简写     | 降低 SDK 使用门槛，简单场景无需构造数组                                                                 |
| 内部格式对齐 Anthropic 而非 OpenAI  | Anthropic 的 `content[]` 多 block 模型更具表达力，OpenAI 的 `content + tool_calls` 分离设计需要额外适配 |
| StreamNormalizer 使用有状态推送模式 | 流式 chunk 可能跨事件边界，需要状态机维护当前 block 上下文                                              |
| tool message 的 content 为 string   | 工具结果序列化为 string 传给模型，避免嵌套结构复杂化                                                    |
| normalize 在进入 Loop 前执行一次    | 避免 Loop 内部反复处理两种形式的分支逻辑                                                                |
