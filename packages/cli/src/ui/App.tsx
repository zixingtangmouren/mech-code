import React from 'react'
import type { Agent } from '@mech/core'
import { Session } from './components/Session.js'

interface AppProps {
  agent: Agent
}

export function App({ agent }: AppProps): React.ReactElement {
  return <Session agent={agent} />
}
