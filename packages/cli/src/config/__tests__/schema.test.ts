import { describe, expect, it, vi } from 'vitest'
import { resolveProviderConfig } from '../schema.js'

describe('resolveProviderConfig', () => {
  it('passes protocol and default params through to provider config', () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key')

    expect(
      resolveProviderConfig({
        model: 'gpt-5',
        apiKeyEnv: 'OPENAI_API_KEY',
        protocol: 'responses',
        defaultParams: {
          maxTokens: 4096,
          extra: {
            reasoning: { effort: 'high', summary: 'auto' },
          },
        },
      }),
    ).toEqual({
      model: 'gpt-5',
      apiKey: 'test-key',
      protocol: 'responses',
      defaultParams: {
        maxTokens: 4096,
        extra: {
          reasoning: { effort: 'high', summary: 'auto' },
        },
      },
    })

    vi.unstubAllEnvs()
  })
})
