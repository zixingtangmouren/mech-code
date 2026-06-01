# @mech-code/shared

[English](./README.md)

Mech-Code monorepo 的跨包共享类型与工具函数。该包**无任何运行时依赖**，同时被 `@mech-code/core` 和 `@mech-code/cli` 消费。

通常不需要单独安装此包 —— `@mech-code/core` 已重新导出所有内容。

## 安装

```bash
npm install @mech-code/shared
# 或
pnpm add @mech-code/shared
```

## 内容

### 消息类型

```ts
import type { Message, UserContentBlock, AssistantContentBlock } from '@mech-code/shared'

// 用户消息 —— 支持文本和多模态内容
const msg: Message = { role: 'user', content: 'Hello!' }

// 助手消息 —— 支持文本、工具调用和思考块
const msg: Message = {
  role: 'assistant',
  content: [
    { type: 'text', text: '我来读取这个文件。' },
    { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'src/index.ts' } },
  ],
}
```

### Agent 事件类型

`agent.run()` 发出的全部 19 种事件类型：

```ts
import type { AgentEvent } from '@mech-code/shared'

// 运行生命周期
'agent_run_start' | 'agent_run_end'

// 思考过程
;'reasoning_start' | 'reasoning_content' | 'reasoning_end'

// 文本输出
;'text_start' | 'text_delta' | 'text_end'

// 工具调用
;'tool_start' | 'tool_input_delta' | 'tool_executing' | 'tool_result' | 'tool_end'

// MCP 调用
;'mcp_start' | 'mcp_executing' | 'mcp_result' | 'mcp_end'

// 轮次管理
'turn_start' | 'turn_end'

// HITL 暂停
;('suspended')
```

### 用量统计

```ts
import type { Usage } from '@mech-code/shared'

interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}
```

### 工具定义（精简视图）

```ts
import type { ToolDefinition } from '@mech-code/shared'

// 发送给 LLM 的最小表示
interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}
```

### HITL Checkpoint 类型

```ts
import type { SessionCheckpoint, SerializableAgentState } from '@mech-code/shared'
```

### 工具函数

```ts
import { expandPath } from '@mech-code/shared'
// 将 ~ 展开为 home 目录

import { levenshtein } from '@mech-code/shared'
// 计算两个字符串的编辑距离
```

## 许可证

MIT
