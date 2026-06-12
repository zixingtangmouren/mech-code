import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAIProvider } from '../provider.js'
import { OpenAICompatibleProvider } from '../../openai-compatible/provider.js'
import { UserMessage } from '../../../message/message.js'

describe('OpenAIProvider protocol selection', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses Chat Completions endpoint by default', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const provider = new OpenAIProvider({ apiKey: 'test', model: 'gpt-4o-mini' })
    await provider.chat({ messages: [new UserMessage('hi', { metadata: { hidden: true } })] })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
    expect(init.method).toBe('POST')
    expect(init.body).toContain('"messages"')
    expect(init.body).not.toContain('hidden')
  })

  it('uses Responses endpoint when protocol is responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const provider = new OpenAIProvider({
      apiKey: 'test',
      model: 'gpt-5',
      protocol: 'responses',
    })
    const response = await provider.chat({
      messages: [new UserMessage('hi')],
    })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/responses')
    expect(init.method).toBe('POST')
    expect(init.body).toContain('"input"')
    expect(response.content).toEqual([{ type: 'text', text: 'ok' }])
  })

  it('allows OpenAI-compatible providers to opt into Responses endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const provider = new OpenAICompatibleProvider({
      apiKey: 'test',
      model: 'custom',
      baseUrl: 'https://example.test',
      protocol: 'responses',
    })
    await provider.chat({ messages: [new UserMessage('hi')] })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://example.test/v1/responses')
    expect(init.method).toBe('POST')
  })
})
