/**
 * 中间件示例：Todo 任务管理
 *
 * 演示如何使用 todoMiddleware 中间件让 Agent 自动管理复杂任务的 todo list：
 *   - Agent 会自动判断是否需要创建 todo list（≥3 步骤时）
 *   - Agent 会自动更新任务状态（pending → in_progress → completed）
 *   - 当长时间未更新 todo 时，Agent 会收到提醒
 *   - 简单的任务不会触发 todo list（避免 token 浪费）
 *
 * 运行方式：
 *   pnpm --filter @mech-code/core example:todo
 *
 * 需要在环境变量中设置：
 *   DEEPSEEK_API_KEY=sk-...
 */

import * as readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { z } from 'zod'
import { Agent, OpenAICompatibleProvider, createAgentState, defineTool } from '../src/index.js'
import { todoMiddleware } from '../../middleware/src/index.js'
import type { AgentEvent } from '@mech-code/shared'

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
}

type TodoStatus = 'pending' | 'in_progress' | 'completed'

interface TodoEventItem {
  content: string
  status: TodoStatus
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

// ─── 自定义工具：文件写入（模拟） ────────────────────────────────────────────

const mockWriteFileTool = defineTool({
  name: 'write_file',
  description: '将内容写入指定文件（模拟）。',
  schema: z.object({
    path: z.string().describe('文件路径'),
    content: z.string().describe('要写入的内容'),
  }),
  flags: { readonly: false, parallelSafe: false },
  execute({ path, content }) {
    // 模拟写入延迟
    return {
      content: `文件 "${path}" 写入成功，共 ${String(content).length} 字符。`,
      isError: false,
    }
  },
})

// ─── 事件渲染 ────────────────────────────────────────────────────────────────

/**
 * 专门渲染 todo 工具的调用事件，以更友好的格式展示 todo list。
 */
function renderTodoEvent(event: AgentEvent): void {
  if (event.type === 'tool_start' && event.toolName === 'write_todos') {
    process.stdout.write(`\n${c.magenta}📋 Todo 列表更新中...${c.reset}\n`)
  }

  if (event.type === 'tool_executing' && event.toolName === 'write_todos') {
    const rawTodos = (event.input as Record<string, unknown> | undefined)?.todos
    const todos = Array.isArray(rawTodos) ? rawTodos.filter(isTodoEventItem) : []
    if (todos.length > 0) {
      process.stdout.write(`${c.magenta}┌─ Todo 列表 ──────────────────────────────${c.reset}\n`)
      for (const todo of todos) {
        const statusIcon =
          todo.status === 'completed'
            ? `${c.green}✓${c.reset}`
            : todo.status === 'in_progress'
              ? `${c.yellow}⟳${c.reset}`
              : `${c.gray}○${c.reset}`
        const statusColor =
          todo.status === 'completed' ? c.green : todo.status === 'in_progress' ? c.yellow : c.gray
        process.stdout.write(
          `${c.magenta}│${c.reset} ${statusIcon} ${statusColor}${todo.content}${c.reset}\n`,
        )
      }
      process.stdout.write(`${c.magenta}└──────────────────────────────────────────${c.reset}\n`)
    }
  }

  if (event.type === 'tool_result' && event.toolName === 'write_todos') {
    if (!event.isError) {
      process.stdout.write(`${c.green}  ✓ Todo 列表已更新${c.reset}\n`)
    } else {
      process.stdout.write(`${c.red}  ✗ Todo 列表更新失败: ${String(event.output)}${c.reset}\n`)
    }
  }
}

function isTodoEventItem(value: unknown): value is TodoEventItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.content === 'string' &&
    (record.status === 'pending' ||
      record.status === 'in_progress' ||
      record.status === 'completed')
  )
}

function renderEvent(event: AgentEvent): void {
  // 先尝试 todo 专用渲染
  renderTodoEvent(event)

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

    // 工具调用（非 todo 工具）
    case 'tool_start':
      if (event.toolName === 'write_todos') break // 已由 renderTodoEvent 处理
      process.stdout.write(
        `\n${c.blue}⚙ 调用工具:${c.reset} ${c.bold}${event.toolName}${c.reset}\n`,
      )
      break
    case 'tool_executing':
      if (event.toolName === 'write_todos') break
      process.stdout.write(
        `${c.gray}  输入: ${JSON.stringify(event.input, null, 2)
          .split('\n')
          .join('\n  ')}${c.reset}\n`,
      )
      break
    case 'tool_result':
      if (event.toolName === 'write_todos') break
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

  // 创建 Todo 中间件
  // turnsBetweenReminders: 每隔多少轮提醒一次未完成的 todo（默认 10）
  // turnsSinceWrite: 距离上次 write_todos 多少轮后触发提醒（默认 10）
  // toolResultMode: 'summary' 返回摘要 | 'full' 返回完整 JSON
  const todo = todoMiddleware({
    turnsBetweenReminders: 5, // 更频繁的提醒，方便演示
    turnsSinceWrite: 3, // 更早触发提醒，方便演示
    toolResultMode: 'summary',
  })

  // 注册工具列表
  const tools = [getWeatherTool, calculatorTool, mockWriteFileTool]

  // 创建 Provider（DeepSeek 兼容 OpenAI API 格式）
  const provider = new OpenAICompatibleProvider({
    apiKey,
    model: 'deepseek-reasoner',
    baseUrl: 'https://api.deepseek.com',
  })

  // 创建 Agent，注入 Todo 中间件
  // 注意：中间件声明的 write_todos 工具会自动合并到可用工具集中
  const agent = new Agent({
    provider,
    tools,
    middleware: [todo],
    system: `你是一个智能助手，具备以下能力：
- 天气查询（get_weather）：查询各城市天气
- 数学计算（calculator）：执行数学表达式计算
- 文件写入（write_file）：将内容写入文件

当用户提出复杂的多步骤任务时（≥3 步），请使用 write_todos 工具来规划和跟踪任务进度。
简单任务直接完成即可，不需要创建 todo list。

请用中文回答，保持简洁清晰。`,
  })

  // 初始化会话状态
  const state = createAgentState()

  // 创建终端 readline 接口
  const rl = readline.createInterface({ input: stdin, output: stdout })

  console.log(`${c.bold}${c.cyan}Mech Agent —— Todo 中间件示例${c.reset}`)
  console.log(
    `${c.gray}可用工具：${c.reset}${c.blue}get_weather${c.reset}${c.gray}（天气查询）、${c.reset}${c.blue}calculator${c.reset}${c.gray}（数学计算）、${c.reset}${c.blue}write_file${c.reset}${c.gray}（模拟写入）${c.reset}`,
  )
  console.log(
    `${c.gray}内置工具：${c.reset}${c.magenta}write_todos${c.reset}${c.gray}（Todo 任务管理，由中间件自动注入）${c.reset}`,
  )
  console.log(
    `${c.gray}提示：尝试让 Agent 完成一个多步骤的复杂任务，观察它如何使用 Todo 列表${c.reset}`,
  )
  console.log(
    `${c.gray}例如："帮我查询北京、上海、广州三个城市的天气，计算它们的平均温度，然后把结果写入 weather-report.txt"${c.reset}`,
  )
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
