# @mech-code/cli

[中文文档](./README.zh-CN.md)

The terminal UI and CLI entry point for Mech-Code. Built with [React Ink](https://github.com/vadimdemedes/ink), it provides an interactive chat interface powered by `@mech-code/core`.

## Installation

```bash
npm install -g @mech-code/cli
```

## Usage

```bash
# Start an interactive chat session
mech chat

# Use a specific provider
mech chat -p deepseek

# Use a specific model
mech chat -m claude-opus-4-5
```

## Configuration

**Global config** `~/.mech/config.json`:

```json
{
  "default": "claude",
  "providers": {
    "claude": {
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

**Project config** `.mech.json` (place in the project root, overrides global):

```json
{
  "provider": "claude",
  "model": "claude-opus-4-5",
  "system": "You are a code assistant for this project.",
  "toolResult": {
    "maxResultChars": 50000,
    "previewChars": 8000,
    "strategy": "preview_and_store",
    "storage": { "type": "state" },
    "cleanup": {
      "enabled": true,
      "trigger": { "turns": 10 },
      "keepRecentToolResults": 10
    }
  },
  "contextCompact": {
    "summaryProvider": "claude",
    "modelContextWindow": 200000,
    "trigger": { "fraction": 0.7 },
    "summary": {
      "maxTokens": 4096,
      "temperature": 0
    },
    "reactiveCompact": {
      "enabled": true,
      "maxRetries": 1
    }
  }
}
```

Config priority: **CLI flags > `.mech.json` > `~/.mech/config.json` > environment variables**

`toolResult` and `contextCompact` are independent middleware config blocks. `contextManagement`
is no longer supported.

## Slash Commands

| Command  | Description                |
| -------- | -------------------------- |
| `/help`  | Show available commands    |
| `/clear` | Clear conversation history |
| `/exit`  | Exit the program           |

## Keyboard Shortcuts

| Shortcut | Action                       |
| -------- | ---------------------------- |
| `Enter`  | Send message                 |
| `Ctrl+J` | Insert newline               |
| `Esc`    | Interrupt current generation |
| `Ctrl+C` | Exit                         |

## License

MIT
