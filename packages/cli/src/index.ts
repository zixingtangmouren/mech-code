import { program } from 'commander'
import { registerChatCommand } from './commands/index.js'

program.name('mech').description('A Claude Code like terminal CLI powered by LLM').version('0.1.0')

registerChatCommand(program)

program.parse()
