import type { Command } from 'commander'

export function registerChatCommand(program: Command): void {
  program
    .command('chat')
    .description('Start an interactive chat session')
    .option('-m, --model <model>', 'LLM model to use')
    .option('-p, --provider <provider>', 'Provider name from config')
    .action(async () => {
      // TODO: 加载配置、创建 agent、渲染界面
      const { render } = await import('ink')
      const React = await import('react')
      const { App } = await import('../ui/App.js')
      render(React.createElement(App))
    })
}
