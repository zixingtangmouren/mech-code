<div align="center">

# Mech-Code

**由 LLM 驱动的终端编程智能体 —— 开发者的机械搭档。**

[English](./README.md) · [开发指南](./DEVELOPMENT.md)

</div>

---

Mech-Code 是一个由 LLM 驱动的终端编程智能体，定位类似 Claude Code，致力于成为开发者最得力的"机械搭档"。它深度融入你的开发工作流，自动化处理复杂任务、重构遗留代码，并提供具备上下文感知能力的智能建议，助你以极高的速度和精度交付生产级代码。

## 特性

- **多轮对话** —— 在交互式终端会话中完整维护上下文
- **流式输出** —— 响应逐 token 实时显示
- **工具调用** —— 使用 Zod schema 定义类型安全的工具，智能体自动调用
- **多 Provider 支持** —— 支持 Anthropic、OpenAI 及任意 OpenAI 兼容端点（DeepSeek、Ollama 等）
- **MCP 集成** —— 通过 stdio JSON-RPC 接入外部 MCP 服务，无限扩展智能体能力
- **中间件管道** —— 以可插拔方式接入重试、限流、权限等横切逻辑，不侵入核心代码
- **多模态消息** —— 在同一会话中传入文本、图片（base64 / URL）和文件
- **项目级配置** —— 在仓库根目录放置 `.mech.json`，即可为当前项目单独设定模型、系统提示词和启用的技能

## 包结构

Mech-Code 采用 **pnpm monorepo** + **SDK-First** 架构：核心库承载所有智能，CLI 只是 SDK 的消费者。

| 包                                       | 说明                                               |
| ---------------------------------------- | -------------------------------------------------- |
| [`@mech-code/shared`](./packages/shared) | 跨包共享类型与工具函数（无运行时依赖）             |
| [`@mech-code/core`](./packages/core)     | Agent Loop、Provider、工具系统、MCP 客户端、中间件 |
| [`@mech-code/cli`](./packages/cli)       | 终端 UI（React Ink）、配置加载、CLI 入口           |

## 安装

```bash
npm install -g @mech-code/cli
```

## 快速开始

**1. 创建配置文件** `~/.mech/config.json`：

```json
{
  "default": "claude",
  "providers": {
    "claude": {
      "model": "claude-opus-4-5",
      "apiKeyEnv": "ANTHROPIC_API_KEY"
    }
  }
}
```

**2. 开始对话：**

```bash
mech chat
```

## 配置说明

### 全局配置 `~/.mech/config.json`

```json
{
  "default": "anthropic",
  "providers": {
    "anthropic": {
      "model": "claude-opus-4-5",
      "apiKeyEnv": "ANTHROPIC_API_KEY"
    },
    "deepseek": {
      "baseUrl": "https://api.deepseek.com/v1",
      "model": "deepseek-chat",
      "apiKey": "sk-xxx"
    },
    "local": {
      "baseUrl": "http://localhost:11434/v1",
      "model": "llama3",
      "apiKey": "none"
    }
  }
}
```

### 项目级配置 `.mech.json`（覆盖全局）

```json
{
  "provider": "anthropic",
  "model": "claude-opus-4-5",
  "system": "You are a code assistant for this project.",
  "mcp": {
    "servers": {
      "filesystem": { "command": "npx", "args": ["-y", "@mcp/filesystem"] }
    }
  }
}
```

配置优先级：**CLI 参数 > `.mech.json` > `~/.mech/config.json` > 环境变量**

## 开发

请参阅 [DEVELOPMENT.md](./DEVELOPMENT.md) 了解完整的本地开发与发布流程。

```bash
pnpm install      # 安装依赖
pnpm dev          # 监听模式启动所有包
pnpm build        # 构建所有包
pnpm test         # 运行测试（Vitest）
pnpm typecheck    # TypeScript 类型检查
pnpm lint         # ESLint 检查
```

提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/) 规范（commitlint 强制执行）。

## 许可证

MIT
