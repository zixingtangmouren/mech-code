import type { SessionCheckpoint } from '@mech-code/shared'
import type { RunConfig } from './types.js'

export type { SessionCheckpoint, SerializableAgentState, PendingToolCall } from '@mech-code/shared'

/**
 * 中间件通过在 wrapToolCall 中抛出 SuspendSignal 来声明"需要暂停"。
 * Loop 捕获后不走 error 路径，而是进入 suspend 流程。
 */
export class SuspendSignal extends Error {
  readonly name = 'SuspendSignal'

  constructor(
    /** 暂停原因（业务层用于展示） */
    public readonly reason: string,
    /** 附带的业务数据（如待审批的工具信息） */
    public readonly payload?: Record<string, unknown>,
  ) {
    super(`SuspendSignal: ${reason}`)
  }
}

/** 判断是否为 SuspendSignal（用于 catch 块中判断） */
export function isSuspendSignal(err: unknown): err is SuspendSignal {
  return err instanceof SuspendSignal
}

/** 人工对单个工具调用的决策 */
export type ToolCallDecision =
  | { action: 'approve' }
  | { action: 'deny'; reason?: string }
  | { action: 'modify'; input: Record<string, unknown> }

/** 恢复运行时业务层传入的参数 */
export interface ResumeParams {
  /** 从哪个 checkpoint 恢复 */
  checkpoint: SessionCheckpoint
  /** 人工决策结果（按 toolCallId 索引） */
  decisions: Record<string, ToolCallDecision>
  /** 本次恢复运行的运行配置 */
  config?: RunConfig
  /** 恢复运行时传入的只读属性（同 RunParams.props，不持久化） */
  props?: Readonly<Record<string, unknown>>
}
