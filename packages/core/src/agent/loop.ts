import type { AgentEvent } from '@mech/shared'
import type { MiddlewareContext } from '../middleware/types.js'
import type { RunParams } from './types.js'

/**
 * Agent 循环引擎 —— 编排 LLM 调用 → 工具分发 → 循环的完整周期。
 * 属于基础设施层，不应由用户自行替换。
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function* runLoop(
  _params: RunParams,
  _ctx: MiddlewareContext,
): AsyncGenerator<AgentEvent> {
  // TODO: 实现循环引擎
  throw new Error('Not implemented')
}
