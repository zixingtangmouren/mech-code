import type { AgentEvent } from '@mech-code/shared'
import type { LLMProvider } from '../provider/types.js'
import type { Tool } from '../tools/types.js'
import type { AgentMiddleware } from '../middleware/types.js'
import type { RunParams, RunResult } from './types.js'
import { runLoop, runLoopFromCheckpoint } from './loop.js'
import type { ResumeParams } from './hitl.js'

export interface AgentConfig {
  /** LLM Provider 实例（AnthropicProvider / OpenAIProvider / OpenAICompatibleProvider） */
  provider: LLMProvider
  tools?: Tool[]
  system?: string
  middleware?: AgentMiddleware[]
  /** 最大循环轮数，防止无限循环，默认 20 */
  maxTurns?: number
  /** 工具执行的工作目录，默认为空字符串 */
  cwd?: string
}

export class Agent {
  private readonly _provider: LLMProvider
  private _tools: Tool[]
  private readonly _system: string
  private _middleware: AgentMiddleware[]
  private readonly _maxTurns: number
  private readonly _cwd: string

  constructor(config: AgentConfig) {
    this._provider = config.provider
    this._tools = config.tools ? [...config.tools] : []
    this._system = config.system ?? ''
    this._middleware = config.middleware ? [...config.middleware] : []
    this._maxTurns = config.maxTurns ?? 20
    this._cwd = config.cwd ?? ''
  }

  /**
   * 流式运行 Agent，逐事件 yield（适合实时 UI 渲染）。
   * state.messages 和 state.usage 在运行过程中直接被修改。
   * run() 开始前会将各中间件的 state 与 AgentState.middlewareStates 建立共享引用。
   */
  async *run(params: RunParams): AsyncIterable<AgentEvent> {
    // 将各中间件的公有状态绑定到 AgentState（共享引用）
    for (const mw of this._middleware) {
      if (mw.state !== undefined) {
        const existing = params.state.middlewareStates[mw.name]
        if (existing) {
          // session 恢复场景：将持久化的状态回灌到中间件实例
          Object.assign(mw.state, existing)
        }
        // 建立共享引用，后续中间件对 this.state 的修改自动反映到 AgentState
        params.state.middlewareStates[mw.name] = mw.state
      }
    }
    yield* runLoop(params, {
      provider: this._provider,
      tools: this._tools,
      system: this._system,
      middleware: this._middleware,
      maxTurns: this._maxTurns,
      cwd: this._cwd,
    })
  }

  /**
   * 从 checkpoint 恢复运行 Agent，先处理 pending tool calls 再继续循环。
   */
  async *resume(params: ResumeParams): AsyncIterable<AgentEvent> {
    // 将各中间件的公有状态绑定到从 checkpoint 恢复的 state
    const restoredState = params.checkpoint.state
    for (const mw of this._middleware) {
      if (mw.state !== undefined) {
        const existing = restoredState.middlewareStates[mw.name]
        if (existing) {
          Object.assign(mw.state, existing)
        }
      }
    }
    yield* runLoopFromCheckpoint(params, {
      provider: this._provider,
      tools: this._tools,
      system: this._system,
      middleware: this._middleware,
      maxTurns: params.maxTurns ?? this._maxTurns,
      cwd: this._cwd,
    })
  }

  /**
   * 一次性运行 Agent，等待最终结果。
   * 内部消费 run() 事件流并汇总为 RunResult。
   */
  async complete(params: RunParams): Promise<RunResult> {
    const { state } = params
    const usageAtStart = { ...state.usage }
    let turnsUsed = 0
    let stopReason: RunResult['stopReason'] = 'end_turn'
    let checkpoint: RunResult['checkpoint']

    for await (const event of this.run(params)) {
      if (event.type === 'turn_end') {
        turnsUsed = event.turnIndex + 1
      }
      if (event.type === 'agent_run_end') {
        stopReason = event.stopReason
      }
      if (event.type === 'suspended') {
        checkpoint = event.checkpoint
      }
    }

    const text = getLastAssistantText(state)
    const usage = {
      inputTokens: state.usage.inputTokens - usageAtStart.inputTokens,
      outputTokens: state.usage.outputTokens - usageAtStart.outputTokens,
    }

    return { text, stopReason, usage, turnsUsed, checkpoint }
  }

  /** 运行时追加中间件 */
  use(middleware: AgentMiddleware): void {
    this._middleware.push(middleware)
  }

  /** 动态注册工具 */
  addTool(tool: Tool): void {
    this._tools.push(tool)
  }

  /** 动态移除工具 */
  removeTool(name: string): void {
    this._tools = this._tools.filter((t) => t.name !== name)
  }

  /**
   * 基于当前 Agent 派生新实例，覆盖部分配置。
   * 适合创建子任务 Agent（如只读摘要 Agent、受限权限 Agent）。
   */
  fork(overrides: Partial<AgentConfig>): Agent {
    return new Agent({
      provider: overrides.provider ?? this._provider,
      tools: overrides.tools ?? [...this._tools],
      system: overrides.system ?? this._system,
      middleware: overrides.middleware ?? [...this._middleware],
      maxTurns: overrides.maxTurns ?? this._maxTurns,
      cwd: overrides.cwd ?? this._cwd,
    })
  }
}

export function createAgent(config: AgentConfig): Agent {
  return new Agent(config)
}

/** 从 state.messages 中提取最后一条 assistant 消息的文本 */
function getLastAssistantText(state: RunParams['state']): string {
  const messages = state.messages
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg) continue
    if (msg.role === 'assistant') {
      const content = msg.content
      if (typeof content === 'string') return content
      if (Array.isArray(content)) {
        const blocks = content as Array<{ type: string; text?: string }>
        return blocks
          .filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join('')
      }
    }
  }
  return ''
}
