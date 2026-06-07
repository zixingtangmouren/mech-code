# @mech-code/shared

[中文文档](./README.zh-CN.md)

Shared types and utility functions for the Mech-Code monorepo. This package has **no runtime dependencies** and is consumed by both `@mech-code/core` and `@mech-code/cli`.

You generally do not need to install this package directly — it is re-exported by `@mech-code/core`.

## Installation

```bash
npm install @mech-code/shared
# or
pnpm add @mech-code/shared
```

## Contents

### Message types

```ts
import type { Message, UserContentBlock, AssistantContentBlock } from '@mech-code/shared'

// User message — supports text and multimodal content
const msg: Message = { role: 'user', content: 'Hello!' }

// Assistant message — supports text, tool calls, and thinking blocks
const msg: Message = {
  role: 'assistant',
  content: [
    { type: 'text', text: 'I will read the file.' },
    { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'src/index.ts' } },
  ],
}
```

### Agent event types

All 21 event types emitted by `agent.run()`:

```ts
import type { AgentEvent } from '@mech-code/shared'

// Run lifecycle
'agent_run_start' | 'agent_run_end'

// Thinking / reasoning
;'reasoning_start' | 'reasoning_content' | 'reasoning_end'

// Text output
;'text_start' | 'text_delta' | 'text_end'

// Tool calls
;'tool_start' | 'tool_input_delta' | 'tool_executing' | 'tool_result' | 'tool_end'

// MCP calls
;'mcp_start' | 'mcp_executing' | 'mcp_result' | 'mcp_end'

// State snapshots
;('state_changed')

// Turn management
'turn_start' | 'turn_end'

// HITL pause
;('suspended')
```

### Usage statistics

```ts
import type { Usage } from '@mech-code/shared'

interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}
```

### Tool definition (slim)

```ts
import type { ToolDefinition } from '@mech-code/shared'

// Minimal representation sent to the LLM
interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}
```

### HITL checkpoint types

```ts
import type { SessionCheckpoint, SerializableAgentState } from '@mech-code/shared'
```

### Utility functions

```ts
import { expandPath } from '@mech-code/shared'
// Expands ~ to home directory

import { levenshtein } from '@mech-code/shared'
// Levenshtein edit distance between two strings
```

## License

MIT
