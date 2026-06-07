/**
 * 中间件示例：工具调用鉴权
 *
 * 演示如何使用 wrapToolCall 中间件对写入操作进行交互式鉴权：
 *   - 只读工具（read_file）：直接放行，无需确认
 *   - 写入工具（write_file）：在终端展示确认交互，用户同意后才执行
 *
 * 运行方式：
 *   DEEPSEEK_API_KEY=sk-... npx tsx examples/middleware-auth.ts
 *
 * 需要在环境变量中设置：
 *   DEEPSEEK_API_KEY=sk-...
 */

import * as readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import {
  Agent,
  OpenAICompatibleProvider,
  createMiddleware,
  createAgentState,
} from '../src/index.js'
import type { AgentEvent } from '@mech-code/shared'
import type { Tool } from '../src/index.js'

const { readFileTool, writeFileTool } = await import('../../tools/src/index.js')

// ─── ANSI 颜色工具 ──────────────────────────────────────────────────────────

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  blue: '\x1b[34m',
  bgYellow: '\x1b[43m',
  black: '\x1b[30m',
}

// ─── 工具调用鉴权中间件 ───────────────────────────────────────────────────────

/**
 * 创建工具调用鉴权中间件 —— 对写入类工具进行交互式鉴权。
 *
 * 工作原理：
 * 1. 构造时接收工具列表与共享的 readline 实例（避免多个接口同时监听 stdin）
 * 2. 建立 toolName -> flags.readonly 的映射表
 * 3. 通过 wrapToolCall 拦截每次工具调用
 * 4. 只读工具（flags.readonly = true）直接放行
 * 5. 写入工具（flags.readonly = false）弹出终端确认，用户拒绝则返回错误
 */
function createToolAuthMiddleware(tools: Tool[], rl: readline.Interface) {
  const readonlyMap = new Map(tools.map((t) => [t.name, t.flags.readonly]))

  return createMiddleware({
    name: 'tool-auth',

    async wrapToolCall(request, handler) {
      const isReadonly = readonlyMap.get(request.toolName) ?? true

      // 只读工具直接放行
      if (isReadonly) {
        return handler(request)
      }

      // 写入工具：展示鉴权确认框（参数已由 tool_executing 事件渲染，此处不重复）
      const border = `${c.yellow}${'─'.repeat(40)}${c.reset}`
      process.stdout.write(`  ${border}\n`)
      process.stdout.write(
        `  ${c.bgYellow}${c.black} ⚠ 需要授权 ${c.reset}` +
          ` ${c.bold}${request.toolName}${c.reset} 将执行写入操作\n`,
      )
      process.stdout.write(`  ${border}\n`)

      let answer: string
      try {
        answer = await rl.question(`  ${c.yellow}是否允许？${c.reset} ${c.dim}(y/N)${c.reset} `)
      } catch {
        // readline 被关闭时默认拒绝
        answer = 'n'
      }

      const confirmed = answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes'

      if (confirmed) {
        process.stdout.write(`  ${c.green}✓ 已授权${c.reset}\n`)
        return handler(request)
      }

      process.stdout.write(`  ${c.red}✗ 已拒绝，操作已取消${c.reset}\n`)
      return {
        content: `用户拒绝了对工具 "${request.toolName}" 的调用，操作已取消。`,
        isError: true,
      }
    },
  })
}

// ─── 事件渲染 ────────────────────────────────────────────────────────────────

function renderEvent(event: AgentEvent): void {
  switch (event.type) {
    // 思考过程（流式）
    case 'reasoning_start':
      process.stdout.write(`\n${c.gray}${c.dim}💭 思考中...${c.reset}\n${c.gray}${c.dim}`)
      break
    case 'reasoning_content':
      process.stdout.write(event.text)
      break
    case 'reasoning_end':
      process.stdout.write(`${c.reset}\n`)
      break

    // 模型文字回复（流式）
    case 'text_start':
      process.stdout.write(`\n${c.cyan}${c.bold}Assistant:${c.reset} `)
      break
    case 'text_delta':
      process.stdout.write(event.delta)
      break
    case 'text_end':
      process.stdout.write('\n')
      break

    // 工具调用
    case 'tool_start':
      process.stdout.write(
        `\n${c.blue}⚙ 调用工具:${c.reset} ${c.bold}${event.toolName}${c.reset}\n`,
      )
      break
    case 'tool_executing':
      process.stdout.write(
        `${c.gray}  输入: ${JSON.stringify(event.input, null, 2)
          .split('\n')
          .join('\n  ')}${c.reset}\n`,
      )
      break
    case 'tool_result':
      if (event.isError) {
        process.stdout.write(`${c.red}  错误: ${String(event.output)}${c.reset}\n`)
      } else {
        process.stdout.write(`${c.green}  结果: ${String(event.output)}${c.reset}\n`)
      }
      break

    // 轮次信息
    case 'turn_start':
      if (event.turnIndex > 0) {
        process.stdout.write(`${c.gray}${c.dim}─── 第 ${event.turnIndex + 1} 轮 ───${c.reset}\n`)
      }
      break

    case 'agent_run_end':
      process.stdout.write(
        `\n${c.gray}${c.dim}[用量: 输入 ${event.usage.inputTokens} tokens, 输出 ${event.usage.outputTokens} tokens]${c.reset}\n`,
      )
      break

    default:
      break
  }
}

// ─── 主程序 ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const apiKey = process.env['DEEPSEEK_API_KEY']
  if (!apiKey) {
    console.error(`${c.red}错误：请设置环境变量 DEEPSEEK_API_KEY${c.reset}`)
    process.exit(1)
  }

  // 注册需要鉴权的工具列表
  const tools = [readFileTool, writeFileTool]

  // 创建对话输入 readline 接口（唯一实例，与鉴权中间件共享，避免双重监听 stdin）
  const rl = readline.createInterface({ input: stdin, output: stdout })

  // 创建鉴权中间件，传入共享的 readline 实例
  const authMiddleware = createToolAuthMiddleware(tools, rl)

  // 创建 Provider（DeepSeek 兼容 OpenAI API 格式）
  const provider = new OpenAICompatibleProvider({
    apiKey,
    model: 'qwen3.6-plus',
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode',
  })

  // 创建 Agent，注入鉴权中间件
  const agent = new Agent({
    provider,
    tools,
    middleware: [authMiddleware],
    cwd: process.cwd(),
    system: `你是一个智能文件助手，可以帮助用户读取和写入文件。
- 使用 read_file 工具读取文件内容
- 使用 write_file 工具写入文件（注意：写入操作需要用户授权）
请用中文回答用户的问题，操作前简要说明你打算做什么。`,
  })

  // 初始化会话状态（跨轮次保持对话历史）
  const state = createAgentState()

  console.log(`${c.bold}${c.cyan}Mech Agent —— 中间件鉴权示例${c.reset}`)
  console.log(`${c.gray}可用工具：read_file（直接放行）、write_file（需要鉴权）${c.reset}`)
  console.log(`${c.gray}当前工作目录：${process.cwd()}${c.reset}`)
  console.log(`${c.gray}输入 "exit" 或按 Ctrl+C 退出${c.reset}\n`)

  // 处理退出信号
  process.on('SIGINT', () => {
    console.log(`\n${c.gray}已退出。${c.reset}`)
    rl.close()
    process.exit(0)
  })

  // 对话循环
  while (true) {
    let userInput: string
    try {
      userInput = await rl.question(`${c.bold}You:${c.reset} `)
    } catch {
      // readline 关闭时退出
      break
    }

    userInput = userInput.trim()
    if (!userInput) continue
    if (userInput.toLowerCase() === 'exit') {
      console.log(`${c.gray}再见！${c.reset}`)
      break
    }

    // 将用户消息加入状态
    state.messages.push({
      role: 'user',
      content: [{ type: 'text', text: userInput }],
    })

    // 流式运行 Agent 并渲染事件
    try {
      for await (const event of agent.run({ state })) {
        renderEvent(event)
      }
    } catch (err) {
      console.error(`\n${c.red}运行出错：${String(err)}${c.reset}\n`)
    }
  }

  rl.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
