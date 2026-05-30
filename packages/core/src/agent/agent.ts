import type { AgentEvent } from '@mech/shared'
import type { ProviderConfig } from '../provider/types.js'
import type { Tool } from '../tools/types.js'
import type { AgentMiddleware } from '../middleware/types.js'
import type { RunParams, RunResult } from './types.js'

export interface AgentConfig {
  provider: ProviderConfig
  tools?: Tool[]
  system?: string
  middleware?: AgentMiddleware[]
  maxTurns?: number
}

export class Agent {
  constructor(private readonly config: AgentConfig) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async *run(params: RunParams): AsyncIterable<AgentEvent> {
    // TODO: 实现 Agent 循环引擎
    void params
    throw new Error('Not implemented')
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async complete(params: RunParams): Promise<RunResult> {
    // TODO: 消费 run() 并汇总最终结果
    void params
    throw new Error('Not implemented')
  }
}

export function createAgent(config: AgentConfig): Agent {
  return new Agent(config)
}
