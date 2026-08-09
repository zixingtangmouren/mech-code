import { describe, expect, it, vi } from 'vitest'
import {
  resolveContextCompactConfig,
  resolveProviderConfig,
  resolveToolResultConfig,
} from '../schema.js'

describe('resolveProviderConfig', () => {
  it('passes protocol and default params through to provider config', () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key')

    expect(
      resolveProviderConfig({
        model: 'gpt-5',
        apiKeyEnv: 'OPENAI_API_KEY',
        protocol: 'responses',
        timeoutMs: 120_000,
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
      timeoutMs: 120_000,
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

describe('resolveToolResultConfig', () => {
  it('enables tool result middleware when the config block exists', () => {
    expect(
      resolveToolResultConfig({
        toolResult: {
          maxResultChars: 100,
          cleanup: { maxAgeMs: 3_600_000 },
        },
      }),
    ).toEqual({
      maxResultChars: 100,
      cleanup: { maxAgeMs: 3_600_000 },
    })
  })

  it('returns undefined when tool result middleware is explicitly disabled', () => {
    expect(resolveToolResultConfig({ toolResult: { enabled: false } })).toBeUndefined()
  })
})

describe('resolveContextCompactConfig', () => {
  it('enables context compact middleware when the config block exists', () => {
    expect(
      resolveContextCompactConfig({
        contextCompact: {
          summaryProvider: 'summary',
          trigger: { messages: 10 },
        },
      }),
    ).toEqual({
      summaryProvider: 'summary',
      trigger: { messages: 10 },
    })
  })

  it('returns undefined when context compact middleware is explicitly disabled', () => {
    expect(
      resolveContextCompactConfig({
        contextCompact: { enabled: false, trigger: { messages: 10 } },
      }),
    ).toBeUndefined()
  })
})
