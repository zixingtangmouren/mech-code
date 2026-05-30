import type { Message, Usage } from '@mech/shared'

export interface RunParams {
  messages: Message[]
  maxTurns?: number
  signal?: AbortSignal
}

export interface RunResult {
  text: string
  messages: Message[]
  usage: Usage
  stopReason: 'end_turn' | 'max_turns' | 'error' | 'abort'
}
