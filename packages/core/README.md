# @mech-code/core

[中文文档](./README.zh-CN.md)

`@mech-code/core` is the SDK core of Mech-Code. It contains the Agent loop engine, multi-model Provider adapters, the tool protocol, and the middleware pipeline. It has no dependency on the terminal or UI, and runs on any JS runtime — Node.js, Bun, etc.

## Installation

```bash
npm install @mech-code/core
# or
pnpm add @mech-code/core
```

---

## Quick Start

```ts
import { createAgent, AnthropicProvider, defineTool } from '@mech-code/core'
import { z } from 'zod'

// 1. Define a tool
const readFileTool = defineTool({
  name: 'read_file',
  description: 'Read the contents of a file at the given path',
  schema: z.object({ path: z.string().min(1) }),
  flags: { readonly: true, parallelSafe: true },
  async execute({ path }) {
    const content = await fs.promises.readFile(path, 'utf-8')
    return { content }
  },
})

// 2. Create a provider
const provider = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: 'claude-sonnet-4-20250514',
})

// 3. Create an agent
const agent = createAgent({
  provider,
  tools: [readFileTool],
  system: 'You are a helpful coding assistant.',
})

// 4. Create a state object (owned by the caller, persists across turns)
const state = createAgentState()
state.messages.push({ role: 'user', content: 'Hello!' })

// 5. Stream events
for await (const event of agent.run({ state })) {
  if (event.type === 'text_delta') process.stdout.write(event.delta)
}
// state.messages now contains the full conversation history

// Or wait for the final result
const result = await agent.complete({ state })
console.log(result.text) // result: { text, stopReason, usage, turnsUsed }
```

---

## Provider

A Provider handles communication with an LLM vendor API — serializing the unified internal message format into vendor request bodies and normalizing responses back to a standard format.

### Built-in Providers

| Provider                   | Description                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------- |
| `AnthropicProvider`        | Anthropic native API (Claude)                                                          |
| `OpenAIProvider`           | OpenAI native API                                                                      |
| `OpenAICompatibleProvider` | Generic OpenAI-compatible protocol — covers DeepSeek, Ollama, and 90% of other vendors |

### Configuration (`ProviderConfig`)

```ts
interface ProviderConfig {
  apiKey: string
  model: string
  baseUrl?: string // Custom endpoint (proxy, local model, etc.)
  headers?: Record<string, string> // Additional request headers
  defaultParams?: ModelParams // Default generation parameters
}
```

### Generation Parameters (`ModelParams`)

```ts
interface ModelParams {
  temperature?: number
  maxTokens?: number
  topP?: number
  stopSequences?: string[]
  extra?: Record<string, unknown> // Vendor-specific escape hatch
}
```

`defaultParams` is set at construction time and can be overridden per-call via `CallOptions.modelParams` (shallow merge).

### Non-streaming call

```ts
const response = await provider.chat(params, { modelParams: { temperature: 0.7 } })
// response: { content, usage, stopReason }
```

### Streaming call (`StreamResult`)

`provider.stream()` returns a dual-channel object — an event stream for real-time rendering and a final Promise for the Agent loop:

```ts
const { stream, final, abort } = provider.stream(params)

// Consume the event stream (UI rendering)
for await (const event of stream) {
  process.stdout.write(event.type === 'text_delta' ? event.delta : '')
}

// Await the complete response (Agent loop)
const { content, usage, stopReason } = await final
```

### Error handling (`ProviderError`)

All providers translate vendor errors into a unified `ProviderError`:

```ts
import { ProviderError } from '@mech-code/core'

try {
  await provider.chat(params)
} catch (err) {
  if (err instanceof ProviderError) {
    console.log(err.code) // 'auth_failed' | 'rate_limited' | 'server_error' | ...
    console.log(err.retryable) // whether the error is retryable
    console.log(err.provider) // provider name
  }
}
```

| Code               | Description                      | Retryable |
| ------------------ | -------------------------------- | --------- |
| `auth_failed`      | 401 / 403 authentication failure | No        |
| `rate_limited`     | 429 rate limit                   | Yes       |
| `context_too_long` | Context window exceeded          | No        |
| `model_not_found`  | Model does not exist             | No        |
| `server_error`     | 5xx server error                 | Yes       |
| `network_error`    | Network-level error              | Yes       |
| `invalid_request`  | 4xx bad request                  | No        |
| `aborted`          | User-initiated abort             | No        |

---

## Tool System

### Defining tools (`defineTool`)

The recommended approach is the **Zod schema style**, which provides full type safety and automatic input validation:

```ts
import { defineTool } from '@mech-code/core'
import { z } from 'zod'

const searchTool = defineTool({
  name: 'search',
  description: 'Search for text in the codebase',
  schema: z.object({
    query: z.string().min(1, 'Query must not be empty'),
    path: z.string().optional(),
  }),
  flags: {
    readonly: true, // No side effects — permission middleware can auto-approve
    parallelSafe: true, // Safe to run concurrently
  },
  // `input` is fully typed from the schema — no manual casting needed
  async execute({ query, path }, ctx) {
    // ctx: { cwd, signal, metadata }
    return { content: `Results for: ${query}` }
  },
  // Optional: additional business validation (runs after Zod validation)
  validateInput({ query }) {
    if (query.length > 200) return { valid: false, error: 'Query is too long' }
    return { valid: true }
  },
})
```

You can also use the **raw JSON Schema style** (useful for wrapping MCP tools or avoiding a Zod dependency):

```ts
const tool = defineTool({
  name: 'read_file',
  description: 'Read a file',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  flags: { readonly: true, parallelSafe: true },
  async execute(input) {
    const path = input['path'] as string // Manual cast required
    return { content: '...' }
  },
})
```

### Tool flags (`ToolFlags`)

```ts
interface ToolFlags {
  readonly: boolean // true = no side effects; permission middleware can skip confirmation
  parallelSafe: boolean // true = loop scheduler may run multiple tool_use calls concurrently
}
```

### Tool registry

```ts
import { registerTool, getTool, getAllTools, getToolDefinitions, clearTools } from '@mech-code/core'

registerTool(searchTool)

getTool('search') // Look up by name
getAllTools() // All registered tools
getToolDefinitions() // Slim definitions sent to the LLM (name + description + inputSchema)
clearTools() // Clear the registry (useful in tests)
```

---

## Middleware

Middleware extends Agent behavior in a pluggable way — handling retry, rate-limiting, permissions, logging, and other cross-cutting concerns without touching core logic. Two integration modes:

- **Hook mode** — read and write Context state (logging, context compression, token counting)
- **Wrap mode** — wrap a core operation (retry, caching, circuit breaker, permission gate)

Responsibility boundary: **hooks only read/write state; wraps only wrap behavior** — never mixed.

### Interface

```ts
interface AgentMiddleware {
  name: string
  /** Default shared state: merged into AgentState.store; readable and writable by middleware/tools */
  store?: Record<string, unknown>

  // === Hook mode: observe and modify state ===
  beforeAgent?(ctx: RunContext): Awaitable<void> // run start — initialize
  afterAgent?(ctx: RunContext): Awaitable<void> // run end — like finally
  beforeModel?(ctx: RunContext): Awaitable<void> // modify callMessages / system / tools
  afterModel?(ctx: RunContext): Awaitable<void> // observe model output, update stats

  // === Wrap mode: wrap the core operation ===
  wrapModelCall?(next: ModelCallFn, ctx: RunContext): Awaitable<StreamResult>
  wrapToolCall?(next: ToolCallFn, ctx: ToolCallContext): Awaitable<ToolOutput>
}
```

For stateful middleware, extend the `Middleware` base class:

```ts
import { Middleware } from '@mech-code/core'

class TokenCounterMiddleware extends Middleware {
  name = 'token-counter'

  // Default shared state: bound to AgentState.store at runtime
  store = { totalInputTokens: 0, totalOutputTokens: 0 }

  // Private state: only visible to this instance
  private threshold = 100_000

  afterModel(ctx: RunContext) {
    const { inputTokens, outputTokens } = ctx.lastResponse!.usage
    this.store.totalInputTokens += inputTokens
    this.store.totalOutputTokens += outputTokens
    if (this.store.totalInputTokens > this.threshold) {
      console.warn('Total input tokens exceeded threshold')
    }
  }
}
```

### `RunContext` — what middleware can read and write

```ts
interface RunContext {
  state: AgentState // full conversation state (mutable reference)
  callMessages: Message[] // snapshot sent to the model this turn (beforeModel can rewrite)
  system: string // system prompt this turn (beforeModel can append)
  tools: ToolDefinition[] // tools this turn (beforeModel can filter)
  lastResponse?: ChatResponse // available in afterModel (read-only observation point)
  readonly turnIndex: number
  readonly signal: AbortSignal
}
```

`state` is the persistent truth — mutations here survive across turns. `callMessages` is a per-turn projection — mutations only affect the current model call. `lastResponse` in `afterModel` is read-only: model output should not be modified after streaming.

### Example: logger middleware (Hook mode)

```ts
import type { AgentMiddleware } from '@mech-code/core'

const loggerMiddleware: AgentMiddleware = {
  name: 'logger',
  beforeModel(ctx) {
    console.log(`[Turn ${ctx.turnIndex}] Sending ${ctx.callMessages.length} messages`)
  },
  afterModel(ctx) {
    const { inputTokens, outputTokens } = ctx.lastResponse!.usage
    console.log(`[Turn ${ctx.turnIndex}] Tokens: ${inputTokens} in / ${outputTokens} out`)
  },
}
```

### Example: retry middleware (Wrap mode)

```ts
const retryMiddleware: AgentMiddleware = {
  name: 'retry',
  async wrapModelCall(next, ctx) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await next(ctx)
      } catch (e) {
        if (!(e instanceof ProviderError) || !e.retryable || attempt === 2) throw e
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
      }
    }
    throw new Error('unreachable')
  },
}
```

### Example: permission middleware (Wrap mode)

```ts
const permissionMiddleware: AgentMiddleware = {
  name: 'permission',
  async wrapToolCall(next, ctx) {
    const tool = getTool(ctx.toolName)
    if (!tool?.flags.readonly) {
      const ok = await askUser(`Allow "${ctx.toolName}"?`)
      if (!ok) return { content: 'User denied this action', isError: true }
    }
    return next(ctx)
  },
}
```

### Registering middleware

```ts
const agent = createAgent({
  provider,
  tools: [searchTool, readFileTool],
  middleware: [new TokenCounterMiddleware(), retryMiddleware, permissionMiddleware],
})

// Or attach after construction
agent.use(myMiddleware)
```

---

## Message Protocol

### External message format (SDK surface)

```ts
type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | UserContentBlock[] } // multimodal
  | { role: 'assistant'; content: string | AssistantContentBlock[] }
  | { role: 'tool'; toolCallId: string; content: string }
```

### Multimodal input

```ts
const messages: Message[] = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'What is in this image?' },
      { type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } },
    ],
  },
]
```

### Message utilities

```ts
import {
  normalizeMessage,
  normalizeMessages,
  denormalizeMessage,
  estimateTokens,
} from '@mech-code/core'

// External Message → internal normalized form (string content becomes a content-block array)
const internal = normalizeMessage({ role: 'user', content: 'Hello' })

// Fast approximate token count (character-based, no API call needed)
const tokens = estimateTokens('Hello, world!')
```

---

## Agent

### Creating an agent

```ts
import { createAgent, createAgentState } from '@mech-code/core'

const agent = createAgent({
  provider,            // LLMProvider instance (required)
  tools: [...],        // Available tools
  system: '...',       // System prompt
  middleware: [...],   // Middleware list
  maxTurns: 20,        // Max loop iterations per run (default: 20)
  cwd: process.cwd(),  // Working directory passed to tools
})
```

### Instance methods

```ts
// Core execution
agent.run(params) // AsyncIterable<AgentEvent> — stream events turn-by-turn
agent.complete(params) // Promise<RunResult> — wait for the final result

// Runtime mutation
agent.use(middleware) // append a middleware
agent.addTool(tool) // register a tool dynamically
agent.removeTool('name') // unregister a tool
agent.fork(overrides) // derive a new Agent instance with partial config overridden
```

### State — owned by the caller

Agent state is held externally and passed into every `run()` call. The Agent mutates it in-place (appending messages, accumulating usage). The caller retains the reference — no manual sync needed.

```ts
const state = createAgentState()
// or: { messages: [], usage: { inputTokens: 0, outputTokens: 0 }, store: {} }

// First turn
state.messages.push({ role: 'user', content: 'List the files in src/' })
for await (const event of agent.run({ state, signal: abortController.signal })) {
  // AgentEvent: agent_run_start | turn_start | text_delta | tool_executing | ... | agent_run_end
}

// Second turn — same state continues the conversation
state.messages.push({ role: 'user', content: 'Now explain loop.ts' })
const result = await agent.complete({ state })
console.log(result.text) // final assistant text
console.log(result.turnsUsed) // how many turns this run used
console.log(result.stopReason) // 'end_turn' | 'max_turns' | 'error' | 'abort'
```

### Forking for sub-tasks

```ts
// Main agent has full toolset
const mainAgent = createAgent({ provider, tools: allTools })

// Derived agent with restricted tools and a focused system prompt
const summaryAgent = mainAgent.fork({
  tools: readOnlyTools,
  system: 'You are a summarization assistant. Only read and summarize.',
  maxTurns: 3,
})
```

---

## Exports Reference

| Export                                     | Description                                         |
| ------------------------------------------ | --------------------------------------------------- |
| `createAgent` / `Agent`                    | Agent factory and class                             |
| `createAgentState`                         | Create an empty `AgentState`                        |
| `AgentState` / `AgentMessage`              | Session state types                                 |
| `RunParams` / `RunResult`                  | Agent run input and output types                    |
| `RunContext` / `ToolCallContext`           | Middleware context types                            |
| `ModelCallFn` / `ToolCallFn` / `Awaitable` | Wrap-mode middleware function types                 |
| `Middleware`                               | Stateful middleware base class                      |
| `MiddlewarePipeline`                       | Pipeline executor (advanced use)                    |
| `AnthropicProvider`                        | Anthropic provider                                  |
| `OpenAIProvider`                           | OpenAI provider                                     |
| `OpenAICompatibleProvider`                 | Generic OpenAI-compatible provider                  |
| `ProviderError`                            | Unified provider error class                        |
| `defineTool`                               | Tool definition factory                             |
| `registerTool` / `getTool` / `getAllTools` | Tool registry operations                            |
| `normalizeMessage` / `denormalizeMessage`  | Message format conversion                           |
| `estimateTokens`                           | Fast approximate token count                        |
| `Message` / `AgentEvent` / `Usage`         | Shared types (re-exported from `@mech-code/shared`) |
