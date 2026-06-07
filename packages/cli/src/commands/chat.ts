import type { Command } from 'commander'

export function registerChatCommand(program: Command): void {
  program
    .command('chat')
    .description('Start an interactive chat session')
    .option('-m, --model <model>', 'LLM model to use')
    .option('-p, --provider <provider>', 'Provider name from config')
    .action(async (options: { model?: string; provider?: string }) => {
      const { render } = await import('ink')
      const React = await import('react')
      const { App } = await import('../ui/App.js')
      const { loadConfig, createProviderFromConfig } = await import('../config/loader.js')
      const { resolveContextManagementConfig } = await import('../config/schema.js')
      const { createAgent } = await import('@mech-code/core')
      const { contextManagementMiddleware, todoMiddleware } = await import('@mech-code/middleware')
      const { getBuiltinTools } = await import('@mech-code/tools')
      const { buildSystemPrompt } = await import('../prompts/system.js')

      // 加载配置
      const config = await loadConfig()

      // 确定使用哪个 provider
      const providerName = options.provider ?? config.default ?? config.provider
      if (!providerName || !config.providers?.[providerName]) {
        console.error(
          `错误: 未指定 provider。请通过 -p 参数指定，或在配置文件中设置 "default"。\n` +
            `可用 providers: ${Object.keys(config.providers ?? {}).join(', ') || '(无)'}`,
        )
        process.exit(1)
      }

      const providerEntry = config.providers[providerName]!
      // 如果 CLI 传了 model 参数，覆盖配置
      if (options.model) {
        providerEntry.model = options.model
      }

      const provider = createProviderFromConfig(providerName, providerEntry)
      const cwd = process.cwd()
      const tools = getBuiltinTools()
      const system = config.system ?? buildSystemPrompt(cwd)
      const middleware = [todoMiddleware()]
      const createConfiguredProvider = (name: string) => {
        if (!config.providers?.[name]) {
          console.error(
            `错误: contextManagement 引用了不存在的 provider "${name}"。\n` +
              `可用 providers: ${Object.keys(config.providers ?? {}).join(', ') || '(无)'}`,
          )
          process.exit(1)
        }
        return createProviderFromConfig(name, config.providers[name]!)
      }
      const contextManagement = resolveContextManagementConfig(config)
      if (contextManagement) {
        const contextProvider = contextManagement.provider
          ? createConfiguredProvider(contextManagement.provider)
          : undefined
        const summaryProvider = contextManagement.summaryProvider
          ? createConfiguredProvider(contextManagement.summaryProvider)
          : undefined

        middleware.push(
          contextManagementMiddleware({
            provider: contextProvider,
            summaryProvider,
            modelContextWindow: contextManagement.modelContextWindow,
            reservedOutputTokens: contextManagement.reservedOutputTokens,
            trigger: contextManagement.trigger,
            keep: contextManagement.keep,
            summary: contextManagement.summary,
            toolResults: contextManagement.toolResults,
            cleanup: contextManagement.cleanup,
            reactiveCompact: contextManagement.reactiveCompact,
          }),
        )
      }

      const agent = createAgent({
        provider,
        tools,
        middleware,
        system,
        maxTurns: 20,
      })

      render(React.createElement(App, { agent, model: providerEntry.model, cwd }))
    })
}
