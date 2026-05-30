import type { MCPConfig } from './types.js'

/**
 * MCP 客户端 —— 启动 MCP 服务子进程并通过 stdio JSON-RPC 进行通信。
 */
export class MCPClient {
  constructor(private readonly config: MCPConfig) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async connect(): Promise<void> {
    // TODO: 启动服务子进程并建立 JSON-RPC 连接
    void this.config
    throw new Error('Not implemented')
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async disconnect(): Promise<void> {
    // TODO: 优雅关闭所有服务子进程
    throw new Error('Not implemented')
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listTools(): Promise<unknown[]> {
    // TODO: 在每个已连接服务上调用 tools/list
    throw new Error('Not implemented')
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async callTool(_server: string, _name: string, _params: unknown): Promise<unknown> {
    // TODO: 将工具调用路由到正确的服务
    throw new Error('Not implemented')
  }
}
