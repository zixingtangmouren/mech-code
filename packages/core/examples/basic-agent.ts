/**
 * 基础示例：创建 Agent + 自定义工具 + 终端对话
 *
 * 运行方式：
 *   pnpm --filter @mech/core example
 *
 * 需要在环境变量中设置：
 *   DEEPSEEK_API_KEY=sk-...
 */

import * as readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { z } from 'zod'
import { Agent, OpenAICompatibleProvider, createAgentState, defineTool } from '../src/index.js'
import type { AgentEvent } from '@mech/shared'

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
}

// ─── 自定义工具：天气查询（模拟） ────────────────────────────────────────────

const getWeatherTool = defineTool({
  name: 'get_weather',
  description: '查询指定城市的当前天气情况。',
  schema: z.object({
    city: z.string().describe('城市名称，如"北京"、"上海"'),
    unit: z.enum(['celsius', 'fahrenheit']).optional().default('celsius').describe('温度单位'),
  }),
  flags: { readonly: true, parallelSafe: true },
  execute({ city, unit }) {
    // 模拟天气数据（实际场景替换为真实 API）
    const weatherData: Record<string, { temp: number; condition: string; humidity: number }> = {
      北京: { temp: 18, condition: '晴', humidity: 40 },
      上海: { temp: 22, condition: '多云', humidity: 65 },
      广州: { temp: 28, condition: '阵雨', humidity: 80 },
      深圳: { temp: 27, condition: '小雨', humidity: 75 },
      成都: { temp: 20, condition: '阴', humidity: 70 },
    }

    const data = weatherData[city] ?? { temp: 15, condition: '未知', humidity: 50 }
    const temp = unit === 'fahrenheit' ? Math.round((data.temp * 9) / 5 + 32) : data.temp
    const unitStr = unit === 'fahrenheit' ? '°F' : '°C'

    return {
      content: JSON.stringify({
        city,
        temperature: `${temp}${unitStr}`,
        condition: data.condition,
        humidity: `${data.humidity}%`,
      }),
      isError: false,
    }
  },
})

// ─── 自定义工具：计算器 ──────────────────────────────────────────────────────

const calculatorTool = defineTool({
  name: 'calculator',
  description: '执行数学表达式计算，支持加减乘除和基本数学运算。',
  schema: z.object({
    expression: z.string().describe('数学表达式，如 "2 + 3 * 4" 或 "Math.sqrt(16)"'),
  }),
  flags: { readonly: true, parallelSafe: true },
  execute({ expression }) {
    try {
      // 限制只允许安全的数学表达式（仅允许数字、运算符和 Math 对象）
      const safePattern = /^[\d\s+\-*/().,^%Math.sqrtpowlogfloorceiliabsroundminmax]+$/
      if (!safePattern.test(expression)) {
        return { content: '错误：不允许的表达式内容', isError: true }
      }
      const result: unknown = new Function(`return ${expression}`)()
      return { content: `${expression} = ${String(result)}`, isError: false }
    } catch {
      return { content: `计算失败：无效的表达式 "${expression}"`, isError: true }
    }
  },
})

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
        `\n${c.yellow}⚙ 调用工具:${c.reset} ${c.bold}${event.toolName}${c.reset}\n`,
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

  // 创建 Provider（DeepSeek 兼容 OpenAI API 格式）
  const provider = new OpenAICompatibleProvider({
    apiKey,
    model: 'deepseek-reasoner',
    baseUrl: 'https://api.deepseek.com',
  })

  // 创建 Agent
  const agent = new Agent({
    provider,
    tools: [getWeatherTool, calculatorTool],
    system: `你是一个智能助手，可以帮助用户查询天气和进行数学计算。
请用中文回答用户的问题。回答要简洁清晰。`,
  })

  // 初始化会话状态（跨轮次保持对话历史）
  const state = createAgentState()

  // 创建终端 readline 接口
  const rl = readline.createInterface({ input: stdin, output: stdout })

  console.log(`${c.bold}${c.cyan}Mech Agent 示例${c.reset}`)
  console.log(`${c.gray}可用工具：get_weather（天气查询）、calculator（数学计算）${c.reset}`)
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
