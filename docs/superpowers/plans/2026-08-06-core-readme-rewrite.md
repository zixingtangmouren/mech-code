# Core README Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the English and Chinese `@mech-code/core` READMEs with accurate, task-oriented user guides based only on the package's current public API.

**Architecture:** Treat `packages/core/src/index.ts` as the public API boundary and keep both READMEs structurally equivalent. Lead with a complete minimal example, then explain the main integration tasks in the order SDK users encounter them: state and execution, providers, tools, middleware, events and cancellation, HITL, and advanced helpers.

**Tech Stack:** Markdown, TypeScript examples, `@mech-code/core`, Zod 4, pnpm workspace, TypeScript, ESLint, Vitest, tsup

---

## File Structure

- Modify `packages/core/README.md`: canonical English SDK user guide.
- Modify `packages/core/README.zh-CN.md`: Chinese guide with matching scope, ordering, links, and code.
- Create temporary TypeScript and tsconfig files under `packages/core` when validating the main code block; remove them immediately after the check and do not commit them.

### Task 1: Rewrite the English SDK guide

**Files:**

- Modify: `packages/core/README.md`

- [ ] **Step 1: Replace the introduction and installation sections**

Describe `@mech-code/core` as a UI-independent TypeScript agent runtime. State the supported built-in providers and primary extension points without mentioning internal-only MCP or Skills modules. Keep the language switch link and install commands:

````markdown
# @mech-code/core

[中文文档](./README.zh-CN.md)

`@mech-code/core` is the UI-independent agent runtime behind Mech-Code. Use it to build terminal agents, background workers, web backends, or your own chat interface with a shared execution model for providers, tools, state, streaming, middleware, and human approval.

## Installation

```bash
pnpm add @mech-code/core zod
```
````

- [ ] **Step 2: Add a complete quick-start example**

The example must import `readFile` from `node:fs/promises`, import the five public SDK symbols it uses, define a Zod-backed read-only tool, create an `OpenAICompatibleProvider`, create state, append a `UserMessage`, and stream `text_delta` events:

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

Explain that `state` is mutated in place and reused for later turns.

- [ ] **Step 3: Document the task-oriented core workflow**

Add these sections in this order, keeping interface excerpts smaller than their current versions:

1. `How the agent runs`: explain caller-owned state, `run()`, `complete()`, `RunResult`, `AbortController`, multi-turn state reuse, and `Agent.fork()`.
2. `Choose a provider`: compare `AnthropicProvider`, `OpenAIProvider`, and `OpenAICompatibleProvider`; document `ProviderConfig`, `protocol: 'chat' | 'responses'`, default parameters, per-call overrides at the provider level, and custom endpoints.
3. `Define tools`: show the Zod form first, explain `readonly` and `parallelSafe`, then show a compact raw JSON Schema form. Explain that tool validation failures are returned to the model as error results.
4. `Add middleware`: explain Hook and Wrap responsibilities, show `createMiddleware()` with state, a small logging hook, and a `wrapToolCall` approval pattern. Mention middleware-provided tools and name-conflict rejection.
5. `Consume events and handle errors`: group the public event families, show `text_delta` handling, document cancellation and `ProviderError` codes/retryability without copying every internal event interface.
6. `Pause for human approval`: show middleware throwing `SuspendSignal`, capturing a `suspended` checkpoint from `complete()`, and resuming with `agent.resume({ checkpoint, decisions })`. State clearly that resume reconstructs state from the checkpoint.
7. `Messages and persistence`: show multimodal `UserMessage`, `serializeAgentState()`, and `deserializeAgentState()`.
8. `Public API at a glance`: list public exports by functional group and link to `examples/basic-agent.ts`, `examples/middleware-auth.ts`, and `examples/middleware-todo.ts`.

- [ ] **Step 4: Check the English document against the public entry point**

Run:

```bash
rg -o "from '@mech-code/core'" packages/core/README.md
git diff --check -- packages/core/README.md
```

Expected: all SDK examples import from the package root, and `git diff --check` prints no errors.

### Task 2: Rewrite the Chinese SDK guide

**Files:**

- Modify: `packages/core/README.zh-CN.md`

- [ ] **Step 1: Mirror the English information architecture in natural Chinese**

Use the same section order, code examples, tables, cautions, and example links. Translate user-facing prose naturally while retaining API identifiers. The opening must identify the package as an SDK runtime rather than a CLI:

```markdown
# @mech-code/core

[English](./README.md)

`@mech-code/core` 是 Mech-Code 的无 UI Agent 运行时。你可以用它构建终端智能体、后台任务、Web 服务或自己的对话界面，并通过统一模型管理 Provider、工具、会话状态、流式事件、中间件和人工审批。
```

- [ ] **Step 2: Keep code behavior identical while localizing explanatory strings**

The Chinese quick start must preserve imports, object shapes, method calls, and control flow from the English example. Only descriptions, prompt strings, comments, and surrounding prose may change. The HITL example must use the same `SuspendSignal`, checkpoint capture, decision map, and `agent.resume()` flow.

- [ ] **Step 3: Compare both guides structurally**

Run:

````bash
rg '^## ' packages/core/README.md
rg '^## ' packages/core/README.zh-CN.md
rg -c '^```' packages/core/README.md packages/core/README.zh-CN.md
git diff --check -- packages/core/README.md packages/core/README.zh-CN.md
````

Expected: corresponding top-level sections appear in the same order, code-fence counts match, and no whitespace errors are reported.

### Task 3: Validate examples and repository health

**Files:**

- Verify: `packages/core/README.md`
- Verify: `packages/core/README.zh-CN.md`
- Verify: `packages/core/src/index.ts`

- [ ] **Step 1: Verify every documented package-root symbol is exported**

Compare all names imported from `@mech-code/core` in both READMEs with `packages/core/src/index.ts`. Remove or correct any symbol that is not publicly exported. Confirm that MCP and Skills internals are absent from feature claims and API lists.

- [ ] **Step 2: Type-check the complete quick-start example**

Extract the English quick-start block into a temporary `.ts` file inside `packages/core`, add it to a temporary `tsconfig` that extends `packages/core/tsconfig.json`, run `pnpm exec tsc --noEmit -p <temporary-tsconfig>`, then remove both temporary files.

Expected: TypeScript exits with code 0 and no diagnostics.

- [ ] **Step 3: Run formatting and Markdown checks**

Run:

```bash
pnpm exec prettier --check packages/core/README.md packages/core/README.zh-CN.md docs/superpowers/plans/2026-08-06-core-readme-rewrite.md
git diff --check
```

Expected: Prettier reports all matched files use its style, and `git diff --check` prints no errors.

- [ ] **Step 4: Run the required repository verification suite**

Run each command separately and require exit code 0:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Expected: all workspace type checks, ESLint checks, Vitest suites, and package builds pass.

- [ ] **Step 5: Review the final diff and commit only task files**

Run:

```bash
git status --short
git diff -- packages/core/README.md packages/core/README.zh-CN.md docs/superpowers/plans/2026-08-06-core-readme-rewrite.md
```

Confirm `docs/18-current-architecture.md` remains untouched and untracked. Stage only the plan and two README files, then commit:

```bash
git add docs/superpowers/plans/2026-08-06-core-readme-rewrite.md packages/core/README.md packages/core/README.zh-CN.md
git commit -m "docs(core): rewrite sdk readme"
```
