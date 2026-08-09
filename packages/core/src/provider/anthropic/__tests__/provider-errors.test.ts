import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@mech-code/shared'
import type { StreamResult } from '../../types.js'
import { UserMessage } from '../../../message/message.js'
import { AnthropicProvider } from '../provider.js'

describe('AnthropicProvider error handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects an error event received after a successful HTTP response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse(
          {
            type: 'error',
            error: { type: 'overloaded_error', message: 'Overloaded' },
            request_id: 'req_body',
          },
          { 'request-id': 'req_header', 'retry-after': '3' },
        ),
      ),
    )

    const provider = new AnthropicProvider({ apiKey: 'test', model: 'claude-sonnet-4-5' })
    const result = provider.stream({ messages: [new UserMessage('hi')] })
    const finalAssertion = expect(result.final).rejects.toMatchObject({
      code: 'overloaded',
      provider: 'anthropic',
      retryable: true,
      vendorCode: 'overloaded_error',
      requestId: 'req_header',
      retryAfterMs: 3000,
    })

    await expect(collectStream(result)).rejects.toMatchObject({ code: 'overloaded' })
    await finalAssertion
  })

  it('preserves structured metadata for a 529 overload response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'overloaded_error', message: 'Overloaded' },
            request_id: 'req_body',
          }),
          {
            status: 529,
            headers: { 'request-id': 'req_header', 'retry-after': '4' },
          },
        ),
      ),
    )

    const provider = new AnthropicProvider({ apiKey: 'test', model: 'claude-sonnet-4-5' })

    await expect(provider.chat({ messages: [new UserMessage('hi')] })).rejects.toMatchObject({
      code: 'overloaded',
      retryable: true,
      status: 529,
      vendorCode: 'overloaded_error',
      requestId: 'req_header',
      retryAfterMs: 4000,
    })
  })

  it('rejects a truncated stream without message_stop', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse({
          type: 'message_start',
          message: { usage: { input_tokens: 1, output_tokens: 0 } },
        }),
      ),
    )

    const provider = new AnthropicProvider({ apiKey: 'test', model: 'claude-sonnet-4-5' })
    const result = provider.stream({ messages: [new UserMessage('hi')] })
    const finalAssertion = expect(result.final).rejects.toMatchObject({ code: 'invalid_response' })

    await expect(collectStream(result)).rejects.toMatchObject({ code: 'invalid_response' })
    await finalAssertion
  })

  it('does not retry an Anthropic billing error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'billing_error', message: 'Billing issue' },
          }),
          { status: 402 },
        ),
      ),
    )

    const provider = new AnthropicProvider({ apiKey: 'test', model: 'claude-sonnet-4-5' })

    await expect(provider.chat({ messages: [new UserMessage('hi')] })).rejects.toMatchObject({
      code: 'billing_error',
      retryable: false,
      status: 402,
    })
  })
})

async function collectStream(result: StreamResult): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of result.stream) events.push(event)
  return events
}

function sseResponse(event: Record<string, unknown>, headers?: HeadersInit): Response {
  return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers })
}
