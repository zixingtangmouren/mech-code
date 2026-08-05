# @mech-code/core

[中文文档](./README.zh-CN.md)

`@mech-code/core` is the UI-independent agent runtime behind Mech-Code. Use it to build terminal agents, background workers, web backends, or your own chat interface with a shared execution model for providers, tools, state, streaming, middleware, and human approval.

The package is ESM-only and expects a modern JavaScript runtime with `fetch`, `AbortController`, and `structuredClone`. The examples below use Node.js and TypeScript.

## Installation

```bash
pnpm add @mech-code/core zod
# or
npm install @mech-code/core zod
```

Zod is only required when you use the recommended type-safe tool definition API. You can define tools with JSON Schema instead.

## Quick Start

This example connects to an OpenAI-compatible endpoint, gives the agent one read-only tool, and streams its response:

```ts
import { readFile } from 'node:fs/promises'
import {
  OpenAICompatibleProvider,
  UserMessage,
  createAgent,
  createAgentState,
  defineTool,
} from '@mech-code/core'
import { z } from 'zod'

const readFileTool = defineTool({
  name: 'read_file',
  description: 'Read a UTF-8 text file',
  schema: z.object({ path: z.string().min(1) }),
  flags: { readonly: true, parallelSafe: true },
  async execute({ path }) {
    return { content: await readFile(path, 'utf8') }
  },
})

const provider = new OpenAICompatibleProvider({
  apiKey: process.env.LLM_API_KEY ?? '',
  baseUrl: process.env.LLM_BASE_URL ?? 'http://localhost:11434/v1',
  model: process.env.LLM_MODEL ?? 'qwen2.5-coder:7b',
})

const agent = createAgent({
  provider,
  tools: [readFileTool],
  system: 'You are a concise coding assistant.',
})

const state = createAgentState()
state.messages.push(new UserMessage('Summarize package.json'))

for await (const event of agent.run({ state, props: { cwd: process.cwd() } })) {
  if (event.type === 'text_delta') process.stdout.write(event.delta)
}
```

`agent.run()` mutates `state` in place. When it finishes, the state contains the assistant messages, tool results, and cumulative token usage. Reuse the same object for the next user turn.

## How the Agent Runs

An Agent combines one provider with a system prompt, a set of tools, optional middleware, and a loop limit:

```ts
const agent = createAgent({
  provider,
  tools: [readFileTool],
  middleware: [],
  system: 'You are a coding assistant.',
  maxTurns: 20,
})
```

The caller owns the conversation state. Push a new `UserMessage` before each run and keep the same state to continue the conversation:

```ts
const state = createAgentState()

state.messages.push(new UserMessage('List the main modules.'))
await agent.complete({ state })

state.messages.push(new UserMessage('Which module owns tool execution?'))
const result = await agent.complete({
  state,
  props: { cwd: process.cwd(), requestId: 'req-42' },
})

console.log(result.text)
console.log(result.stopReason)
console.log(result.usage)
```

`props` is read-only, run-scoped data for middleware and tools. It is not saved in checkpoints.

Choose an execution method based on how you consume output:

| Method                   | Use it when                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `agent.run(params)`      | You need an `AsyncIterable<AgentEvent>` for live rendering, tool progress, or state snapshots.    |
| `agent.complete(params)` | You only need the final `RunResult`: text, stop reason, incremental usage, turns, and checkpoint. |
| `agent.resume(params)`   | You are continuing pending tool calls from a human-approval checkpoint.                           |

The default loop limit is 20 model turns. Override it per Agent with `maxTurns`, or for one run with `config.maxTurns`.

### Cancellation

Pass an `AbortSignal` for cooperative cancellation:

```ts
import { ProviderError } from '@mech-code/core'

const controller = new AbortController()

const running = agent.complete({
  state,
  config: { signal: controller.signal },
})

controller.abort('user_cancelled')

try {
  await running
} catch (error) {
  if (!(error instanceof ProviderError) || error.code !== 'aborted') throw error
}
```

Providers also expose `abort()` on their low-level `StreamResult`. At the Agent level, prefer a run signal so the same cancellation reaches the provider, middleware, and tools.

### Runtime changes and forks

```ts
agent.addTool(readFileTool)
agent.removeTool('read_file')
agent.use(loggingMiddleware)

const reviewAgent = agent.fork({
  tools: [readFileTool],
  system: 'Review code without modifying files.',
  maxTurns: 5,
})
```

`fork()` creates a new Agent with copied configuration and the supplied overrides. Conversation state is still supplied separately.

## Choose a Provider

All built-in providers implement the same `LLMProvider` interface and normalize messages, tool calls, streaming events, usage, and errors.

| Provider                   | Use case                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `AnthropicProvider`        | Anthropic's native Messages API.                                                     |
| `OpenAIProvider`           | OpenAI Chat Completions or Responses API.                                            |
| `OpenAICompatibleProvider` | Third-party or local OpenAI-compatible endpoints such as DeepSeek, Ollama, and vLLM. |

```ts
import { AnthropicProvider, OpenAICompatibleProvider, OpenAIProvider } from '@mech-code/core'

const anthropic = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: process.env.ANTHROPIC_MODEL!,
})

const openai = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: process.env.OPENAI_MODEL!,
  protocol: 'responses',
})

const local = new OpenAICompatibleProvider({
  apiKey: 'unused',
  baseUrl: 'http://localhost:11434/v1',
  model: 'qwen2.5-coder:7b',
})
```

Provider constructors accept:

```ts
interface ProviderConfig {
  apiKey: string
  model: string
  baseUrl?: string
  protocol?: 'chat' | 'responses'
  headers?: Record<string, string>
  defaultParams?: {
    temperature?: number
    maxTokens?: number
    topP?: number
    stopSequences?: string[]
    extra?: Record<string, unknown>
  }
}
```

`protocol` applies to OpenAI-style providers and defaults to `chat`. Set `baseUrl` for proxies or custom endpoints. `defaultParams` applies to every call and is shallow-merged with per-call `modelParams` when you use `provider.chat()` or `provider.stream()` directly.

```ts
const response = await openai.chat(
  { messages: [new UserMessage('Say hello.')] },
  { modelParams: { temperature: 0.2, maxTokens: 100 } },
)

const { stream, final, abort } = openai.stream({
  messages: [new UserMessage('Explain this API.')],
})
```

`stream` emits normalized events, `final` resolves to the complete `ChatResponse`, and `abort()` cancels the request.

## Define Tools

Tools expose a name, description, input schema, execution function, and two scheduling/policy flags. The Zod form provides inferred input types and runtime validation:

```ts
import { defineTool } from '@mech-code/core'
import { z } from 'zod'

const searchTool = defineTool({
  name: 'search',
  description: 'Search project text files',
  schema: z.object({
    query: z.string().min(1),
    path: z.string().default('.'),
  }),
  flags: {
    readonly: true,
    parallelSafe: true,
  },
  validateInput({ query }) {
    return query.length <= 200 ? { valid: true } : { valid: false, error: 'Query is too long' }
  },
  async execute({ query, path }, context) {
    return {
      content: `Search ${path} for ${query}`,
      metadata: { requestId: context.props.requestId },
    }
  },
})
```

- `readonly` describes whether a tool has side effects. Core does not enforce permissions; middleware can use this flag to decide whether approval is required.
- `parallelSafe` allows the Agent loop to execute multiple calls to that tool concurrently. Calls without this flag are run sequentially.
- `content` is sent back to the model. Optional `metadata` carries host-side structured data and is not sent as ordinary model content.

For existing JSON Schema definitions, use the raw form:

```ts
const rawTool = defineTool({
  name: 'lookup',
  description: 'Look up a value',
  inputSchema: {
    type: 'object',
    properties: { key: { type: 'string' } },
    required: ['key'],
    additionalProperties: false,
  },
  flags: { readonly: true, parallelSafe: true },
  execute(input) {
    return { content: String(input.key) }
  },
})
```

Invalid input becomes an error tool result that the model can inspect. An exception thrown by a tool remains an execution error.

### Tool registry

The package also exports a process-level registry:

```ts
import { getAllTools, getTool, registerTool } from '@mech-code/core'

registerTool(searchTool)
getTool('search')

const agent = createAgent({ provider, tools: getAllTools() })
```

Registering a tool does not add it to existing Agents automatically. Pass registry tools to `createAgent()` or add them with `agent.addTool()`.

## Add Middleware

Middleware packages cross-cutting behavior without changing the Agent loop. There are two complementary styles:

- Lifecycle hooks (`beforeAgent`, `afterAgent`, `beforeModel`, `afterModel`) observe or update state around a run or model turn.
- Wrappers (`wrapModelCall`, `wrapToolCall`) intercept one concrete provider or tool call for retry, caching, fallback, permissions, or result processing.

`createMiddleware()` is the concise option for most middleware. Default state is cloned and merged into the caller's `AgentState` without overwriting existing keys:

```ts
import { createMiddleware } from '@mech-code/core'

const loggingMiddleware = createMiddleware({
  name: 'logging',
  state: { modelCalls: 0 },
  beforeModel(ctx) {
    ctx.state.modelCalls = Number(ctx.state.modelCalls) + 1
    ctx.runtime.notifyStateChanged('model_call_counted', ['modelCalls'])
    console.log('turn', ctx.loopState.turnIndex)
  },
  async wrapToolCall(request, handler) {
    const startedAt = Date.now()
    const output = await handler(request)
    return {
      ...output,
      metadata: { ...output.metadata, durationMs: Date.now() - startedAt },
    }
  },
})

const agent = createAgent({
  provider,
  middleware: [loggingMiddleware],
})
```

Middleware can include `tools`, making one self-contained capability with behavior, state, and callable tools. Core rejects duplicate tool names across Agent configuration and middleware.

Use the `Middleware` base class when a class with private runtime fields is a better fit. `MiddlewarePipeline` is also exported for advanced integrations, but normal applications should register middleware through the Agent.

## Consume Events and Handle Errors

`agent.run()` and `agent.resume()` emit a shared `AgentEvent` union. Common event families are:

| Events                                                                        | Meaning                             |
| ----------------------------------------------------------------------------- | ----------------------------------- |
| `agent_run_start`, `agent_run_end`, `turn_start`, `turn_end`                  | Run and model-turn lifecycle.       |
| `reasoning_start`, `reasoning_content`, `reasoning_end`                       | Streaming model reasoning.          |
| `text_start`, `text_delta`, `text_end`                                        | Streaming assistant text.           |
| `tool_start`, `tool_input_delta`, `tool_executing`, `tool_result`, `tool_end` | Tool-call progress and output.      |
| `state_changed`                                                               | Serializable state snapshot.        |
| `suspended`                                                                   | A checkpoint that needs a decision. |

Use a discriminated switch for exhaustive handling:

```ts
for await (const event of agent.run({ state })) {
  switch (event.type) {
    case 'text_delta':
      process.stdout.write(event.delta)
      break
    case 'tool_executing':
      console.error(`Running ${event.toolName}`)
      break
    case 'agent_run_end':
      console.error(`Stopped: ${event.stopReason}`)
      break
  }
}
```

All built-in providers normalize API failures into `ProviderError`:

```ts
import { ProviderError } from '@mech-code/core'

try {
  await agent.complete({ state })
} catch (error) {
  if (error instanceof ProviderError) {
    console.error(error.provider, error.code, error.retryable)
  } else {
    throw error
  }
}
```

| Code               | Retryable |
| ------------------ | --------- |
| `auth_failed`      | No        |
| `rate_limited`     | Yes       |
| `context_too_long` | No        |
| `model_not_found`  | No        |
| `server_error`     | Yes       |
| `network_error`    | Yes       |
| `invalid_request`  | No        |
| `aborted`          | No        |
| `unknown`          | No        |

Use `error.retryable` rather than hard-coding this table in application logic. The exported `retryStreamResult()` helper is available when implementing retry middleware around a streaming provider call.

## Pause for Human Approval

A tool wrapper can throw `SuspendSignal` to stop before a sensitive operation. The Agent returns a serializable checkpoint with all pending tool calls:

```ts
import { SuspendSignal, createMiddleware } from '@mech-code/core'

const sensitiveTools = new Set(['write_file', 'run_command'])

const approvalMiddleware = createMiddleware({
  name: 'approval',
  async wrapToolCall(request, handler) {
    if (!sensitiveTools.has(request.toolName) || request.context.props.approved === true) {
      return handler(request)
    }

    throw new SuspendSignal('approval_required', {
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      input: request.toolInput,
    })
  },
})
```

Use `complete()` when you want the checkpoint directly in the result, then provide one decision per pending tool call:

```ts
const firstRun = await agent.complete({ state })

if (firstRun.stopReason === 'suspended' && firstRun.checkpoint) {
  const decisions = Object.fromEntries(
    firstRun.checkpoint.pendingToolCalls.map((call) => [call.id, { action: 'approve' as const }]),
  )

  for await (const event of agent.resume({
    checkpoint: firstRun.checkpoint,
    decisions,
    props: { approved: true },
  })) {
    if (event.type === 'text_delta') process.stdout.write(event.delta)
  }
}
```

Each decision can `approve`, `deny` with an optional reason, or `modify` the tool input. `resume()` reconstructs state from the checkpoint, applies the decisions, executes remaining tools, and continues the Agent loop. It does not mutate the original pre-resume `state` object; consume `state_changed` snapshots or the final events if the caller needs to persist the resumed state.

## Messages and Persistence

Use message classes when adding history to `AgentState`. User messages support text, URL or base64 images, and binary files. Actual modality support depends on the selected model and provider.

```ts
const message = new UserMessage([
  { type: 'text', text: 'Describe this screenshot.' },
  {
    type: 'image',
    source: { type: 'url', url: 'https://example.com/screenshot.png' },
  },
])

state.messages.push(message)
```

Persist state with the exported serializers. They preserve message metadata and restore message class instances:

```ts
import { deserializeAgentState, serializeAgentState } from '@mech-code/core'

const json = JSON.stringify(serializeAgentState(state))
await storage.set('session-42', json)

const restored = deserializeAgentState(JSON.parse(await storage.get('session-42')))
restored.messages.push(new UserMessage('Continue.'))
await agent.complete({ state: restored })
```

`estimateTokens()`, `estimateMessageTokens()`, and `estimateMessagesTokens()` provide fast character-based estimates for local budgeting. They are approximations, not provider billing values.

## Public API at a Glance

| Area       | Main exports                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agent      | `Agent`, `createAgent`, `createAgentState`, `serializeAgentState`, `deserializeAgentState`, `SuspendSignal`, `isSuspendSignal`                                                       |
| Providers  | `AnthropicProvider`, `OpenAIProvider`, `OpenAICompatibleProvider`, `ProviderError`, `retryStreamResult`                                                                              |
| Tools      | `defineTool`, `registerTool`, `getTool`, `getAllTools`, `getToolDefinitions`, `clearTools`                                                                                           |
| Middleware | `Middleware`, `createMiddleware`, `MiddlewarePipeline`                                                                                                                               |
| Messages   | `SystemMessage`, `UserMessage`, `AssistantMessage`, `ToolMessage`, `MessageAccumulator`, `buildChatParams`                                                                           |
| Utilities  | `estimateTokens`, `estimateMessageTokens`, `estimateMessagesTokens`                                                                                                                  |
| Types      | `AgentState`, `AgentEvent`, `RunParams`, `RunResult`, `LLMProvider`, `ProviderConfig`, `Tool`, `AgentMiddleware`, `RunContext`, `ToolCallDecision`, and related request/result types |

## Examples

- [Basic Agent](./examples/basic-agent.ts): tools, multi-turn state, and event rendering.
- [Authorization middleware](./examples/middleware-auth.ts): policy checks around tool calls.
- [Todo middleware](./examples/middleware-todo.ts): a self-contained middleware with state and tools.
