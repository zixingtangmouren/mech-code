import { describe, expect, it, vi } from 'vitest'
import { resolveContextManagementConfig, resolveProviderConfig } from '../schema.js'

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

describe('resolveContextManagementConfig', () => {
  it('enables context management when the config block exists', () => {
    expect(
      resolveContextManagementConfig({
        contextManagement: {
          summaryProvider: 'summary',
          trigger: { messages: 10 },
          keep: { messages: 4 },
        },
      }),
    ).toEqual({
      summaryProvider: 'summary',
      trigger: { messages: 10 },
      keep: { messages: 4 },
    })
  })

  it('returns undefined when context management is explicitly disabled', () => {
    expect(
      resolveContextManagementConfig({
        contextManagement: { enabled: false, trigger: { messages: 10 } },
      }),
    ).toBeUndefined()
  })
})
