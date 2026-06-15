import type { AgentEvent } from '@mech-code/shared'
import type { ChatParams, ChatResponse, LLMProvider, StreamResult } from '@mech-code/core'
import { describe, expect, it, vi } from 'vitest'
import { buildCliMiddleware, CliMiddlewareConfigError } from '../middleware.js'

function createMockProvider(name = 'mock'): LLMProvider {
  return {
    name,
    async chat(_params: ChatParams): Promise<ChatResponse> {
      throw new Error('not implemented')
    },
    stream(_params: ChatParams): StreamResult {
      return {
        stream: (async function* (): AsyncIterable<AgentEvent> {})(),
        final: Promise.reject(new Error('not implemented')),
        abort() {},
      }
    },
  }
}

describe('buildCliMiddleware', () => {
  it('按最新设计注册默认中间件顺序', () => {
    const middleware = buildCliMiddleware(
      {
        toolResult: {
          maxResultChars: 100,
          previewChars: 20,
        },
        contextCompact: {
          trigger: { messages: 10 },
        },
      },
      { createProviderFromConfig: vi.fn(createMockProvider) },
    )

    expect(middleware.map((item) => item.name)).toEqual(['todo', 'tool-result', 'context-compact'])
  })

  it('未配置上下文管理时只注册 todo 中间件', () => {
    const middleware = buildCliMiddleware(
      {},
      { createProviderFromConfig: vi.fn(createMockProvider) },
    )

    expect(middleware.map((item) => item.name)).toEqual(['todo'])
  })

  it('跳过显式禁用的 toolResult 和 contextCompact 配置', () => {
    const middleware = buildCliMiddleware(
      {
        toolResult: { enabled: false },
        contextCompact: { enabled: false, trigger: { messages: 10 } },
      },
      { createProviderFromConfig: vi.fn(createMockProvider) },
    )

    expect(middleware.map((item) => item.name)).toEqual(['todo'])
  })

  it('为 contextCompact 创建指定的 summary provider', () => {
    const createProviderFromConfig = vi.fn(createMockProvider)

    buildCliMiddleware(
      {
        providers: {
          summary: {
            model: 'summary-model',
          },
        },
        contextCompact: {
          summaryProvider: 'summary',
        },
      },
      { createProviderFromConfig },
    )

    expect(createProviderFromConfig).toHaveBeenCalledWith('summary', { model: 'summary-model' })
  })

  it('contextCompact 引用不存在的 summary provider 时抛出配置错误', () => {
    expect(() =>
      buildCliMiddleware(
        {
          providers: {
            main: {
              model: 'main-model',
            },
          },
          contextCompact: {
            summaryProvider: 'missing',
          },
        },
        { createProviderFromConfig: vi.fn(createMockProvider) },
      ),
    ).toThrow(CliMiddlewareConfigError)
  })
})
