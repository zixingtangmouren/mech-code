# @mech-code/cli

[English](./README.md)

Mech-Code 的终端 UI 和 CLI 入口。基于 [React Ink](https://github.com/vadimdemedes/ink) 构建，以交互式聊天界面驱动 `@mech-code/core`。

## 安装

```bash
npm install -g @mech-code/cli
```

## 使用

```bash
# 启动交互式对话
mech chat

# 指定 provider
mech chat -p deepseek

# 指定模型
mech chat -m claude-opus-4-5
```

## 配置说明

**全局配置** `~/.mech/config.json`：

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

**项目级配置** `.mech.json`（放在项目根目录，会覆盖全局配置）：

```json
{
  "provider": "claude",
  "model": "claude-opus-4-5",
  "system": "You are a code assistant for this project."
}
```

配置优先级：**CLI 参数 > `.mech.json` > `~/.mech/config.json` > 环境变量**

## Slash 命令

| 命令     | 说明         |
| -------- | ------------ |
| `/help`  | 显示帮助信息 |
| `/clear` | 清空对话历史 |
| `/exit`  | 退出程序     |

## 快捷键

| 快捷键   | 操作         |
| -------- | ------------ |
| `Enter`  | 发送消息     |
| `Ctrl+J` | 插入换行符   |
| `Esc`    | 中断当前生成 |
| `Ctrl+C` | 退出         |

## 许可证

MIT
