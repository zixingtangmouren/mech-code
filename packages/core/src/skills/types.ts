import type { Tool, AgentMiddleware } from '@mech/shared'
import type { MiddlewareContext } from '../middleware/types.js'
import type { RunResult } from '../agent/types.js'

export interface Skill {
  name: string
  description: string
  systemPrompt?: string
  tools?: Tool[]
  middleware?: AgentMiddleware[]
  beforeRun?: (ctx: MiddlewareContext) => void
  afterRun?: (ctx: MiddlewareContext, result: RunResult) => void
}
