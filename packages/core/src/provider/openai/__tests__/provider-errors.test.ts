import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@mech-code/shared'
import { ProviderError } from '../../errors.js'
import type { CallOptions, StreamResult } from '../../types.js'
import { UserMessage } from '../../../message/message.js'
import { OpenAIProvider } from '../provider.js'

describe('OpenAIProvider error handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not retry an insufficient quota 429 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message: 'You exceeded your current quota.',
              type: 'insufficient_quota',
              code: 'insufficient_quota',
            },
          }),
          {
            status: 429,
            headers: { 'x-request-id': 'req_quota', 'retry-after': '2.5' },
          },
        ),
      ),
    )

    const provider = new OpenAIProvider({ apiKey: 'test', model: 'gpt-5' })

    await expect(provider.chat({ messages: [new UserMessage('hi')] })).rejects.toMatchObject({
      code: 'quota_exceeded',
      provider: 'openai',
      retryable: false,
      status: 429,
      vendorCode: 'insufficient_quota',
      requestId: 'req_quota',
      retryAfterMs: 2500,
    })
  })

  it('marks a temporary 429 response as retryable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message: 'Rate limit reached.',
              type: 'rate_limit_error',
              code: 'rate_limit_exceeded',
            },
          }),
          { status: 429, headers: { 'retry-after': '1' } },
        ),
      ),
    )

    const provider = new OpenAIProvider({ apiKey: 'test', model: 'gpt-5' })

    await expect(provider.chat({ messages: [new UserMessage('hi')] })).rejects.toMatchObject({
      code: 'rate_limited',
      retryable: true,
      retryAfterMs: 1000,
    })
  })

  it.each([
    {
      name: 'error event',
      event: { type: 'error', code: 'server_error', message: 'stream failed', param: null },
    },
    {
      name: 'response.failed event',
      event: {
        type: 'response.failed',
        response: {
          status: 'failed',
          error: { code: 'server_error', message: 'stream failed' },
        },
      },
    },
  ])('rejects an OpenAI Responses $name', async ({ event }) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(sseResponse([event], 'x-request-id', 'req_stream')),
    )

    const provider = new OpenAIProvider({
      apiKey: 'test',
      model: 'gpt-5',
      protocol: 'responses',
    })
    const result = provider.stream({ messages: [new UserMessage('hi')] })
    const finalAssertion = expect(result.final).rejects.toMatchObject({
      code: 'server_error',
      provider: 'openai',
      retryable: true,
      requestId: 'req_stream',
    })

    await expect(collectStream(result)).rejects.toBeInstanceOf(ProviderError)
    await finalAssertion
  })

  it('rejects malformed SSE JSON instead of returning an empty success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(['not-json'])))

    const provider = new OpenAIProvider({ apiKey: 'test', model: 'gpt-5' })
    const result = provider.stream({ messages: [new UserMessage('hi')] })
    const finalAssertion = expect(result.final).rejects.toMatchObject({ code: 'invalid_response' })

    await expect(collectStream(result)).rejects.toMatchObject({ code: 'invalid_response' })
    await finalAssertion
  })

  it('rejects a malformed known Responses event', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          sseResponse([
            { type: 'response.output_text.delta' },
            { type: 'response.completed', response: { status: 'completed', output: [] } },
          ]),
        ),
    )

    const provider = new OpenAIProvider({
      apiKey: 'test',
      model: 'gpt-5',
      protocol: 'responses',
    })
    const result = provider.stream({ messages: [new UserMessage('hi')] })
    const finalAssertion = expect(result.final).rejects.toMatchObject({ code: 'invalid_response' })

    await expect(collectStream(result)).rejects.toMatchObject({ code: 'invalid_response' })
    await finalAssertion
  })

  it.each([
    {
      protocol: 'chat' as const,
      event: {
        choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }],
      },
    },
    {
      protocol: 'responses' as const,
      event: { type: 'response.output_text.delta', delta: 'partial' },
    },
  ])(
    'rejects a truncated $protocol stream without a terminal event',
    async ({ protocol, event }) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([event])))

      const provider = new OpenAIProvider({ apiKey: 'test', model: 'gpt-5', protocol })
      const result = provider.stream({ messages: [new UserMessage('hi')] })
      const finalAssertion = expect(result.final).rejects.toMatchObject({
        code: 'invalid_response',
      })

      await expect(collectStream(result)).rejects.toMatchObject({ code: 'invalid_response' })
      await finalAssertion
    },
  )

  it('normalizes malformed non-stream JSON as an invalid response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{invalid json')))

    const provider = new OpenAIProvider({ apiKey: 'test', model: 'gpt-5' })

    await expect(provider.chat({ messages: [new UserMessage('hi')] })).rejects.toMatchObject({
      code: 'invalid_response',
      provider: 'openai',
    })
  })

  it('rejects a structurally invalid successful response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [],
            usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
          }),
        ),
      ),
    )

    const provider = new OpenAIProvider({ apiKey: 'test', model: 'gpt-5' })

    await expect(provider.chat({ messages: [new UserMessage('hi')] })).rejects.toMatchObject({
      code: 'invalid_response',
    })
  })

  it('rejects a Responses success object without output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            status: 'completed',
            usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
          }),
        ),
      ),
    )

    const provider = new OpenAIProvider({
      apiKey: 'test',
      model: 'gpt-5',
      protocol: 'responses',
    })

    await expect(provider.chat({ messages: [new UserMessage('hi')] })).rejects.toMatchObject({
      code: 'invalid_response',
    })
  })

  it('aborts a request when the per-call timeout expires', async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            const reason: unknown = init.signal?.reason
            reject(reason instanceof Error ? reason : new Error(String(reason)))
          },
          { once: true },
        )
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const provider = new OpenAIProvider({ apiKey: 'test', model: 'gpt-5' })
    const cleanupController = new AbortController()
    const options = {
      signal: cleanupController.signal,
      timeoutMs: 5,
    } as CallOptions & { timeoutMs: number }
    const request = provider.chat({ messages: [new UserMessage('hi')] }, options)

    try {
      const outcome = await Promise.race([
        request.catch((error: unknown) => error),
        new Promise<'timeout-not-applied'>((resolve) => {
          setTimeout(() => resolve('timeout-not-applied'), 50)
        }),
      ])
      expect(outcome).toMatchObject({ code: 'timeout', retryable: true })
    } finally {
      cleanupController.abort()
      await request.catch(() => undefined)
    }
  })
})

async function collectStream(result: StreamResult): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of result.stream) events.push(event)
  return events
}

function sseResponse(
  events: Array<Record<string, unknown> | string>,
  requestIdHeader?: string,
  requestId?: string,
): Response {
  const body = events
    .map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
    .join('')
  const headers = requestIdHeader && requestId ? { [requestIdHeader]: requestId } : undefined
  return new Response(body, { headers })
}
