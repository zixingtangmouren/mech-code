import type { Tool } from '../tools/types.js'
import type { AgentMiddleware } from '../middleware/types.js'
import type { RunContext } from '../middleware/types.js'
import type { RunResult } from '../agent/types.js'

export interface Skill {
  name: string
  description: string
  systemPrompt?: string
  tools?: Tool[]
  middleware?: AgentMiddleware[]
  beforeRun?: (ctx: RunContext) => void
  afterRun?: (ctx: RunContext, result: RunResult) => void
}
