# 中间件增强：工具注册 + State/Props 分离

## Context

借鉴 LangChain.js Agent Middleware 的设计理念，为 mech-code 的中间件系统引入两个增强：

1. **中间件工具注册** — 让中间件成为自包含的能力单元（tool + state + hooks 内聚），无需上升到 Skill 层
2. **State vs Props 分离** — 区分"中间件内部可变状态"和"调用方传入的只读配置"，类比 React 的 state vs props

两者完全向后兼容，新增字段均为可选。

---

## 改动概览

| 文件                                       | 改动                                                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `packages/core/src/middleware/types.ts`    | 接口新增 `tools`、`propsSchema`、`PropDescriptor`；`RunContext` 新增 `props`              |
| `packages/core/src/middleware/pipeline.ts` | 新增 `collectMiddlewareTools()` 方法                                                      |
| `packages/core/src/agent/types.ts`         | `RunParams` 新增 `props` 字段                                                             |
| `packages/core/src/agent/hitl.ts`          | `ResumeParams` 新增 `props` 字段                                                          |
| `packages/core/src/agent/loop.ts`          | `initLoopInfra` 合并中间件工具；`runLoop`/`runLoopFromCheckpoint` 构造 ctx 时注入 `props` |
| `packages/core/src/index.ts`               | 导出 `PropDescriptor`                                                                     |
| `packages/core/src/middleware/__tests__/`  | 新增测试                                                                                  |

---

## 详细设计

### 1. 中间件工具注册

#### 1.1 `AgentMiddleware` 接口变更

```ts
// middleware/types.ts — 新增 import
import type { Tool } from '../tools/types.js'

export interface AgentMiddleware {
  name: string

  /** 中间件声明的工具（可选），自动合并到 Agent 可用工具集 */
  tools?: Tool[]

  state?: Record<string, unknown>
  // ... 现有 hooks 不变
}
```

`Middleware` 抽象类同步增加 `tools?: Tool[]`。

#### 1.2 `MiddlewarePipeline` 新增收集方法

```ts
// pipeline.ts
collectMiddlewareTools(): Array<{ tool: Tool; source: string }> {
  const result: Array<{ tool: Tool; source: string }> = []
  for (const mw of this.middlewares) {
    if (mw.tools?.length) {
      for (const tool of mw.tools) {
        result.push({ tool, source: mw.name })
      }
    }
  }
  return result
}
```

#### 1.3 `initLoopInfra` 合并逻辑

在 `loop.ts` 的 `initLoopInfra` 中，pipeline 创建后立即收集中间件工具，与 `config.tools` 合并到同一个 `toolMap`：

- **config.tools 先注册**（来源标记 `'__config__'`）
- **中间件工具按注册顺序追加**
- **名称冲突时抛错**（Error 消息明确指出冲突双方）
- `toolDefinitions` 从合并后的 `toolMap` 生成

`baseToolCall` 无需改动 — 它已经用 `toolMap.get(toolCtx.toolName)` 查找工具。

#### 1.4 冲突策略

采用 **fail-fast 错误**：工具名重复立即抛出，不静默覆盖。原因：

- 中间件和 config.tools 都是静态声明，冲突是配置错误
- 错误信息包含冲突双方来源，便于定位

---

### 2. State vs Props 分离

#### 2.1 核心概念

|        | State (`mw.state`)                    | Props (`ctx.props`)             |
| ------ | ------------------------------------- | ------------------------------- |
| 谁写   | 中间件自己                            | 调用方 (`agent.run({ props })`) |
| 谁读   | 中间件自己 + 其他中间件               | 中间件（只读）                  |
| 持久化 | 是（`middlewareStates` → checkpoint） | 否（每次 run 传入）             |
| 语义   | 事实（"发生了什么"）                  | 配置/意图（"你想要什么"）       |

#### 2.2 `RunParams` / `ResumeParams` 新增 `props`

```ts
// agent/types.ts
export interface RunParams {
  state: AgentState
  maxTurns?: number
  signal?: AbortSignal
  /** 调用方传入的只读属性，不持久化 */
  props?: Readonly<Record<string, unknown>>
}

// agent/hitl.ts
export interface ResumeParams {
  checkpoint: SessionCheckpoint
  decisions: Record<string, ToolCallDecision>
  maxTurns?: number
  signal?: AbortSignal
  props?: Readonly<Record<string, unknown>>
}
```

#### 2.3 `RunContext` 新增 `props`

```ts
// middleware/types.ts
export interface RunContext {
  // ... 现有字段
  /** 调用方传入的只读属性（不持久化），语义同 React props */
  readonly props: Readonly<Record<string, unknown>>
  // ...
}
```

`props` 在 `RunContext` 上 **非可选**（总是存在）。调用方不传时默认为 `Object.freeze({})`。

#### 2.4 Loop 中注入 props

`runLoop` 和 `runLoopFromCheckpoint` 构造 `ctx` 对象时：

```ts
const props = Object.freeze(params.props ?? {})
const ctx = { ..., props, ... }
```

`ToolCallContext extends RunContext`，无需额外处理。

#### 2.5 `propsSchema` — 声明式文档化

中间件可选声明自己期望哪些 props：

```ts
export interface PropDescriptor {
  description: string
  required?: boolean
  defaultValue?: unknown
}

export interface AgentMiddleware {
  // ...
  /** 声明中间件期望的 props（文档化 + 开发模式 warning） */
  propsSchema?: Record<string, PropDescriptor>
}
```

开发模式下 (`NODE_ENV !== 'production'`)，`runLoop` 入口处对 `required` 字段缺失发 `console.warn`。不做硬校验，保持灵活性。

#### 2.6 不涉及序列化

`props` 不在 `AgentState` 上，`serializeAgentState` / checkpoint 均不涉及。这是设计核心：props 是临时的。

---

## 验证方案

1. **类型检查**: `pnpm typecheck` 确保无循环依赖、所有接口兼容
2. **单元测试** (`packages/core/src/middleware/__tests__/pipeline.test.ts`):
   - 中间件工具收集：验证 `collectMiddlewareTools()` 正确收集
   - 名称冲突：验证重复工具名抛出包含来源信息的 Error
   - props 透传：mock middleware 读取 `ctx.props`，验证值正确
   - props 不可变：验证 `Object.freeze` 生效
   - props 不持久化：验证 checkpoint 不含 props
3. **集成测试** (`packages/core/src/agent/__tests__/`):
   - 中间件注册的工具可被 LLM 调用（mock provider 返回 tool_use）
   - props 在所有生命周期阶段可读
4. **回归**: `pnpm test` 全量测试通过
