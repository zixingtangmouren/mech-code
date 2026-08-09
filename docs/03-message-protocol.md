# Message 协议设计文档

> 版本：v0.2.0 · 日期：2026-08-08

---

## 1. 设计原则

- **AgentMessage 是唯一运行时消息协议**：Agent Loop、middleware 和 Provider 都直接使用 `AgentMessage[]`。
- **构造输入宽松，实例状态严格**：user/assistant 构造器接受字符串简写，但实例的 `content` 始终是内容块数组。
- **Provider 只处理厂商差异**：serializer 将规范的 `AgentMessage` 直接转换为厂商请求体，不再经过通用中间消息类型。
- **metadata 不承载模型上下文**：metadata 只保存宿主侧信息，不会进入 Provider payload；需要发给模型的数据必须是消息的显式字段。

---

## 2. 类型设计

### 2.1 AgentMessage

```ts
type AgentMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage
```

`AgentState.messages`、`ModelCallRequest.params.messages` 和 `ChatParams.messages` 都使用这个类型。

### 2.2 构造输入与实例不变量

`UserMessage` 和 `AssistantMessage` 接受字符串作为纯文本简写，并在构造时立即转成内容块：

```ts
const user = new UserMessage('hello')
user.content // [{ type: 'text', text: 'hello' }]

const assistant = new AssistantMessage('done')
assistant.content // [{ type: 'text', text: 'done' }]
```

因此，Agent Loop、middleware、tokenizer 和 Provider 不需要处理 `string | blocks[]` 两种运行时形态。

### 2.3 User Content Block

用户消息支持文本和多模态内容：

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

一条 assistant 消息可以同时包含 thinking、文本和多个工具调用：

```ts
type AssistantContentBlock =
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
```

### 2.5 Tool Message

工具执行结果通过 `toolCallId` 与 assistant 消息中的 `tool_use.id` 关联：

```ts
new ToolMessage(toolCallId, toolName, content, {
  image: { type: 'base64', mediaType: 'image/png', data: '...' },
})
```

`content` 始终是文本。图片是可选的显式模型上下文字段，由支持图片工具结果的 Provider 转换；它不存放在 metadata 中。

### 2.6 序列化消息

checkpoint 和事件快照使用不带 class 方法的 `Message` 类型。其 user/assistant content 同样保持内容块数组，序列化和反序列化不会改变消息形态：

```ts
type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: UserContentBlock[] }
  | { role: 'assistant'; content: AssistantContentBlock[] }
  | {
      role: 'tool'
      toolCallId: string
      toolName?: string
      content: string
      image?: ImageSource
    }
```

---

## 3. 消息在 Agent Loop 中的流转

```text
用户输入
│
├─ 构造 UserMessage，并立即形成规范 content blocks
│
├─ Agent Loop / middleware 始终操作 AgentMessage[]
│
├─ Provider serializer: AgentMessage[] → Vendor API Request
│
├─ Vendor Chunk → StreamNormalizer → AgentEvent
│
├─ MessageAccumulator: AgentEvent[] → AssistantContentBlock[]
│
├─ 构造 AssistantMessage 并追加到 state.messages
│
├─ 如果包含 tool_use：执行工具并追加 ToolMessage，然后进入下一轮
│
└─ 无 tool_use：结束循环
```

`state.messages` 在整个过程中始终保持 `AgentMessage[]`。

---

## 4. Provider 转换职责

### 4.1 请求序列化

```ts
interface MessageSerializer<TVendorRequest> {
  serialize(messages: AgentMessage[], options: SerializeOptions): TVendorRequest
}
```

serializer 直接读取规范消息并处理厂商差异：

- Anthropic 把 user/assistant 内容块映射为原生 content blocks。
- OpenAI Chat Completions 将 assistant 的 `tool_use` 块转换为 `tool_calls`。
- OpenAI Responses 将消息拆成 message、`function_call` 和 `function_call_output` input items。
- metadata 不会被序列化；`ToolMessage.image` 由支持该能力的 Provider 显式转换。

#### Anthropic 格式

```ts
// AgentMessage
new AssistantMessage([
  { type: 'text', text: '让我来看看' },
  { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'foo.ts' } },
])

// Anthropic API
{
  role: 'assistant',
  content: [
    { type: 'text', text: '让我来看看' },
    { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'foo.ts' } },
  ],
}
```

#### OpenAI 格式

```ts
// OpenAI Chat Completions API
{
  role: 'assistant',
  content: '让我来看看',
  tool_calls: [
    {
      id: 'call_1',
      type: 'function',
      function: { name: 'read_file', arguments: '{"path":"foo.ts"}' },
    },
  ],
}
```

### 4.2 流式响应转换

```ts
interface StreamNormalizer<TVendorChunk> {
  push(chunk: TVendorChunk): AgentEvent[]
  flush(): AgentEvent[]
  getStreamMeta(): StreamMeta
}
```

每个 Provider 的 normalizer 只负责把厂商 chunk 转换为统一 `AgentEvent`。流结束后，`MessageAccumulator.flush()` 返回 `AssistantContentBlock[]`，再由 `AssistantMessage` 保存为完整回复。

---

## 5. 模块划分

```text
packages/core/src/message/
├── message.ts            # AgentMessage class、构造规范化与序列化
├── builder.ts            # 构建 Provider 调用消息快照
├── accumulator.ts        # AgentEvent[] → AssistantContentBlock[]
└── tokenizer.ts          # token 估算

packages/core/src/provider/
├── types.ts              # Provider 与 serializer/normalizer 协议
├── anthropic/            # Anthropic 请求和流式协议转换
├── openai/               # OpenAI Chat/Responses 请求和流式协议转换
└── openai-compatible/    # OpenAI 兼容 Provider
```

---

## 6. 设计决策记录

| 决策                                     | 原因                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| user/assistant 实例的 content 始终为数组 | 建立单一运行时不变量，避免 Loop、middleware、tokenizer 和 Provider 重复分支    |
| 构造器接受 string 简写                   | 保留简单文本调用的人体工学，同时不把联合类型扩散到实例内部                     |
| 不设置通用 Provider 中间消息类型         | 规范 AgentMessage 已足以承载所有公共语义，再投影一次只会增加转换和类型维护成本 |
| Provider 直接转换 AgentMessage           | 厂商差异只存在于 serializer 边界，职责清晰                                     |
| ToolMessage 图片使用显式字段             | 会发给模型的数据不应藏在只供宿主消费的 metadata 中                             |
| StreamNormalizer 使用有状态推送模式      | 流式 chunk 可能跨事件边界，需要状态机维护当前 block 上下文                     |
| MessageAccumulator 返回内容块数组        | 累积器只负责内容累积，消息对象由调用边界构造                                   |
