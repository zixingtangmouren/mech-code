import type { AgentEvent, AssistantContentBlock } from '@mech-code/shared'
import type { InternalMessage } from './types.js'

/**
 * 流式累积过程中的可变块状态。
 * 与 AssistantContentBlock 分离，因为 tool_use 的输入以原始 JSON 字符串到达，
 * 需要在 flush 时统一解析。
 */
type PendingBlock =
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; inputJson: string }

/**
 * MessageAccumulator（消息累积器）
 *
 * 逐一接收流中的 AgentEvent，并组装出对应的
 * InternalMessage（role: 'assistant'）。
 *
 * 用法：
 *   const acc = new MessageAccumulator()
 *   for await (const event of stream) {
 *     acc.push(event)
 *   }
 *   const msg = acc.flush()   // → InternalMessage
 *   acc.reset()               // 准备好处理下一轮
 */
export class MessageAccumulator {
  private blocks: PendingBlock[] = []
  private currentIndex = -1

  push(event: AgentEvent): void {
    switch (event.type) {
      // === 推理 / 思考 ===
      case 'reasoning_start':
        this.currentIndex = this.blocks.push({ type: 'thinking', text: '' }) - 1
        break

      case 'reasoning_content': {
        const block = this.blocks[this.currentIndex]
        if (block?.type === 'thinking') block.text += event.text
        break
      }

      // === 文本 ===
      case 'text_start':
        this.currentIndex = this.blocks.push({ type: 'text', text: '' }) - 1
        break

      case 'text_delta': {
        const block = this.blocks[this.currentIndex]
        if (block?.type === 'text') block.text += event.delta
        break
      }

      // === 工具调用 ===
      case 'tool_start':
        this.currentIndex =
          this.blocks.push({
            type: 'tool_use',
            id: event.toolCallId,
            name: event.toolName,
            inputJson: '',
          }) - 1
        break

      case 'tool_input_delta': {
        const block = this.blocks[this.currentIndex]
        if (block?.type === 'tool_use') block.inputJson += event.delta
        break
      }

      // 其他事件与消息累积无关，跳过
      default:
        break
    }
  }

  /**
   * 完成累积并返回组装好的 InternalMessage。
   * 将 tool_use 的输入 JSON 字符串解析为对象。
   */
  flush(): InternalMessage {
    const content: AssistantContentBlock[] = this.blocks.map((block): AssistantContentBlock => {
      if (block.type === 'tool_use') {
        let input: Record<string, unknown> = {}
        try {
          input = JSON.parse(block.inputJson) as Record<string, unknown>
        } catch {
          // JSON 格式错误 —— 保留空对象，由调用方自行处理
        }
        return { type: 'tool_use', id: block.id, name: block.name, input }
      }
      return { type: block.type, text: block.text }
    })

    return { role: 'assistant', content }
  }

  /** 返回当前累积状态中所有 tool_use 块 */
  getPendingToolCalls(): Array<{ id: string; name: string; inputJson: string }> {
    return this.blocks
      .filter((b): b is Extract<PendingBlock, { type: 'tool_use' }> => b.type === 'tool_use')
      .map(({ id, name, inputJson }) => ({ id, name, inputJson }))
  }

  /** 判断累积的消息中是否包含 tool_use 块 */
  hasToolUse(): boolean {
    return this.blocks.some((b) => b.type === 'tool_use')
  }

  reset(): void {
    this.blocks = []
    this.currentIndex = -1
  }
}
