export interface MCPServerDef {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface MCPConfig {
  servers: Record<string, MCPServerDef>
}
