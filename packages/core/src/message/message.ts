import type { AssistantContentBlock, UserContentBlock } from '@mech-code/shared'

export type MessageMetadata = Record<string, unknown>

export interface MessageOptions {
  metadata?: MessageMetadata
}

export type SerializedAgentMessage =
  | ({ role: 'system'; content: string } & { metadata?: MessageMetadata })
  | ({ role: 'user'; content: string | UserContentBlock[] } & { metadata?: MessageMetadata })
  | ({ role: 'assistant'; content: string | AssistantContentBlock[] } & {
      metadata?: MessageMetadata
    })
  | ({ role: 'tool'; toolCallId: string; toolName?: string; content: string } & {
      metadata?: MessageMetadata
    })

type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

export abstract class BaseMessage<TRole extends MessageRole, TContent> {
  readonly role: TRole
  content: TContent
  metadata: MessageMetadata

  protected constructor(role: TRole, content: TContent, options: MessageOptions = {}) {
    this.role = role
    this.content = content
    this.metadata = { ...(options.metadata ?? {}) }
  }

  toJSON(): SerializedAgentMessage {
    return {
      role: this.role,
      content: this.content,
      ...(Object.keys(this.metadata).length > 0 ? { metadata: this.metadata } : {}),
    } as SerializedAgentMessage
  }
}

export class SystemMessage extends BaseMessage<'system', string> {
  constructor(content: string, options?: MessageOptions) {
    super('system', content, options)
  }
}

export class UserMessage extends BaseMessage<'user', string | UserContentBlock[]> {
  constructor(content: string | UserContentBlock[], options?: MessageOptions) {
    super('user', content, options)
  }
}

export class AssistantMessage extends BaseMessage<'assistant', string | AssistantContentBlock[]> {
  constructor(content: string | AssistantContentBlock[], options?: MessageOptions) {
    super('assistant', content, options)
  }
}

export class ToolMessage extends BaseMessage<'tool', string> {
  readonly toolCallId: string
  readonly toolName: string

  constructor(toolCallId: string, toolName: string, content: string, options?: MessageOptions) {
    super('tool', content, options)
    this.toolCallId = toolCallId
    this.toolName = toolName
  }

  override toJSON(): SerializedAgentMessage {
    return {
      role: this.role,
      toolCallId: this.toolCallId,
      toolName: this.toolName,
      content: this.content,
      ...(Object.keys(this.metadata).length > 0 ? { metadata: this.metadata } : {}),
    }
  }
}

export type AgentMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage

export function serializeAgentMessage(message: AgentMessage): SerializedAgentMessage {
  return message.toJSON()
}

export function deserializeAgentMessage(message: SerializedAgentMessage): AgentMessage {
  const metadata = message.metadata ?? {}
  switch (message.role) {
    case 'system':
      return new SystemMessage(message.content, { metadata })
    case 'user':
      return new UserMessage(message.content, { metadata })
    case 'assistant':
      return new AssistantMessage(message.content, { metadata })
    case 'tool':
      return new ToolMessage(message.toolCallId, message.toolName ?? 'unknown', message.content, {
        metadata,
      })
  }
}
