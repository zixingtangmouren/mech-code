import type { ToolDefinition } from '@mech-code/shared'

// === 工具固有属性 ===

/**
 * 工具能力标记 —— 描述工具的固有特性，由工具作者在定义时声明，不可运行时修改。
 * 供 Agent Loop 调度器和中间件读取，但不由工具自身做策略决策。
 */
export interface ToolFlags {
  /** 是否只读（无副作用）。只读工具可被权限中间件自动放行 */
  readonly: boolean
  /** 是否可安全并行执行（多次同时调用不会产生竞态）。Loop 调度器据此决定并发策略 */
  parallelSafe: boolean
}

// === 工具执行上下文 ===

/**
 * 传递给 tool.execute() 的运行时上下文。
 * 注意：与中间件的 ToolExecContext 不同，这里只包含工具执行所需的最小信息。
 */
export interface ToolRunContext {
  /** 当前工作目录 */
  cwd: string
  /** 中止信号，工具应在收到信号时尽早终止 */
  signal: AbortSignal
  /** 共享持久状态（session 状态、环境变量、用户配置等） */
  store: Record<string, unknown>
}

// === 工具输出 ===

/**
 * 工具执行的结构化输出。
 * content 返回给 LLM；metadata 供中间件和事件系统消费，不发给 LLM。
 */
export interface ToolOutput {
  /** 返回给 LLM 的文本内容 */
  content: string
  /** 是否为错误结果。影响 Agent Loop 的重试/终止逻辑 */
  isError?: boolean
  /** 附加结构化数据，不发给 LLM（如写入字节数、变更行数等） */
  metadata?: Record<string, unknown>
}

// === 输入校验结果 ===

export interface ValidationResult {
  valid: boolean
  /** 校验失败时的错误描述 */
  error?: string
}

// === 文件读取去重缓存 ===

/**
 * 文件读取缓存条目，用于 read_file / edit_file 工具的读写一致性保证。
 * 通过 ToolRunContext.store.readFileState 传递给工具。
 */
export interface ReadCacheEntry {
  /** 文件读取/写入时的 mtime（毫秒，Math.floor） */
  timestamp: number
  /** 上次读取的起始行 offset */
  offset?: number
  /** 上次读取的行数 limit */
  limit?: number
  /** 文件内容快照（仅全文读取时存储，用于 mtime 变化但内容未变的兜底判断） */
  content?: string
}

// === 完整工具协议 ===

/**
 * Tool —— 自描述的能力单元。
 *
 * 设计原则：工具只声明事实，不做策略决策。
 * 权限判定等策略性逻辑由中间件层负责。
 */
export interface Tool {
  // --- 静态元数据 ---
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly flags: ToolFlags

  /**
   * 输入校验 —— JSON Schema 结构校验之后的业务级约束校验。
   * 处理 Schema 无法表达的运行时约束（路径安全、参数互斥、资源存在性等）。
   *
   * 判断标准：不管在任何环境/策略下都应生效的约束 → validateInput；
   * 会随环境变化的 → 中间件。
   */
  validateInput(input: Record<string, unknown>): ValidationResult | Promise<ValidationResult>

  /**
   * 执行实现
   */
  execute(input: Record<string, unknown>, context: ToolRunContext): Promise<ToolOutput> | ToolOutput

  /**
   * 导出为 LLM 可理解的精简定义。
   * Provider 序列化请求时调用此方法，只需要 name/description/inputSchema。
   */
  toDefinition(): ToolDefinition
}
