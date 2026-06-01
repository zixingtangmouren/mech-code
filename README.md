<div align="center">

# Mech-Code

**An AI-powered coding agent for the terminal — your mechanical partner for developers.**

[中文文档](./README.zh-CN.md) · [Development Guide](./DEVELOPMENT.md)

</div>

---

Mech-Code is an AI-powered terminal coding agent, similar in spirit to Claude Code. It integrates deeply into your development workflow to automate complex tasks, refactor legacy code, and provide context-aware suggestions — helping you ship production-ready software with speed and precision.

## Features

- **Multi-turn conversation** — Maintains full context across an interactive terminal session
- **Streaming output** — Responses appear token-by-token in real time
- **Tool use** — Define type-safe tools with Zod schemas; the agent invokes them automatically
- **Multi-provider support** — Works with Anthropic, OpenAI, and any OpenAI-compatible endpoint (DeepSeek, Ollama, etc.)
- **MCP integration** — Connect external MCP servers via stdio JSON-RPC to extend agent capabilities
- **Middleware pipeline** — Plug in retry, rate-limiting, permissions, and other cross-cutting concerns without touching core logic
- **Multimodal messages** — Pass text, images (base64 / URL), and files in the same conversation
- **Project-level config** — Drop a `.mech.json` in your repo to configure model, system prompt, and skills per project

## Packages

Mech-Code is a **pnpm monorepo** with an SDK-first design: the core library contains all intelligence, and the CLI is simply a consumer of it.

| Package                                  | Description                                                |
| ---------------------------------------- | ---------------------------------------------------------- |
| [`@mech-code/shared`](./packages/shared) | Shared types and utilities (no runtime dependencies)       |
| [`@mech-code/core`](./packages/core)     | Agent loop, providers, tool system, MCP client, middleware |
| [`@mech-code/cli`](./packages/cli)       | Terminal UI (React Ink), config loading, CLI entry point   |

## Installation

```bash
npm install -g @mech-code/cli
```

## Quick Start

**1. Create a config file** at `~/.mech/config.json`:

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

**2. Start chatting:**

```bash
mech chat
```

## Configuration

### Global config `~/.mech/config.json`

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

### Project config `.mech.json` (overrides global)

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

Config priority: **CLI flags > `.mech.json` > `~/.mech/config.json` > environment variables**

## Development

See [DEVELOPMENT.md](./DEVELOPMENT.md) for a full guide on local setup and publishing.

```bash
pnpm install      # Install dependencies
pnpm dev          # Start all packages in watch mode
pnpm build        # Build all packages
pnpm test         # Run tests (Vitest)
pnpm typecheck    # TypeScript type-check
pnpm lint         # ESLint
```

Commits follow the [Conventional Commits](https://www.conventionalcommits.org/) specification (enforced by commitlint).

## License

MIT
"system": "You are a code assistant for this project.",
"mcp": {
"servers": {
"filesystem": { "command": "npx", "args": ["-y", "@mcp/filesystem"] }
}
}
}

````

配置优先级：**CLI 参数 > `.mech.json` > `~/.mech/config.json` > 环境变量**

### 开发命令

```bash
pnpm dev          # 监听模式启动所有包
pnpm build        # 构建所有包
pnpm test         # 运行测试（Vitest）
pnpm test:watch   # 监听模式运行测试
pnpm typecheck    # TypeScript 类型检查
pnpm lint         # ESLint 检查
pnpm lint:fix     # ESLint 自动修复
````

提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/) 规范（commitlint 强制执行）。每次提交前 lint-staged 会自动运行 ESLint 和 Prettier。

### 许可证

MIT
