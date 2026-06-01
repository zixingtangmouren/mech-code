import React from 'react'
import type { Agent } from '@mech-code/core'
import { Session } from './components/Session.js'

interface AppProps {
  agent: Agent
  /** 当前使用的模型名 */
  model: string
  /** 当前工作目录 */
  cwd: string
}

export function App({ agent, model, cwd }: AppProps): React.ReactElement {
  return <Session agent={agent} model={model} cwd={cwd} />
}
