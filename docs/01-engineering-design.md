# mech-code 工程设计文档

> 版本：v0.1.0 · 日期：2026-05-30

---

## 1. 项目概述

mech-code 是一个面向开发者的终端 CLI 产品，定位类似 Claude Code，提供基于 LLM 的交互式终端 AI 助手体验，支持多轮对话、流式输出、工具调用等核心能力。

---

## 2. 技术栈

| 类别        | 方案                              | 说明                       |
| ----------- | --------------------------------- | -------------------------- |
| 语言        | TypeScript 5.x                    | 类型安全，CLI 生态友好     |
| 包管理      | pnpm                              | 性能好，Monorepo 支持佳    |
| 构建        | tsup (esbuild)                    | 零配置打包，支持 ESM 输出  |
| CLI 框架    | commander                         | 子命令注册与参数解析       |
| 终端 UI     | ink + React                       | React 组件模型渲染终端 TUI |
| 格式化      | Prettier                          | 统一代码风格               |
| Lint        | ESLint + typescript-eslint        | 静态分析，类型感知规则     |
| Git Hooks   | simple-git-hooks + lint-staged    | 轻量 Hooks，提交前自动修复 |
| Commit 规范 | commitlint + Conventional Commits | 标准化提交信息格式         |
| 测试        | Vitest + @vitest/coverage-v8      | 兼容 ESM，速度极快         |
| CI          | GitHub Actions                    | 自动化检查与测试           |

---

## 3. 项目目录结构

```
mech-code/
├── .changeset/                   # Changesets 发布配置
├── .github/workflows/            # CI 流水线
├── docs/                         # 设计文档与当前架构说明
├── packages/
│   ├── shared/                   # 跨包协议类型与通用函数
│   │   └── src/
│   ├── core/                     # Agent 核心框架
│   │   ├── examples/             # SDK 使用示例
│   │   └── src/
│   │       ├── agent/            # Agent 外观、循环、状态与 HITL
│   │       ├── events/           # AgentEvent 事件流
│   │       ├── mcp/              # MCP 客户端与协议类型
│   │       ├── message/          # 消息构造、快照与流式累积
│   │       ├── middleware/       # 中间件协议与执行管道
│   │       ├── provider/         # Anthropic、OpenAI 等 Provider
│   │       ├── skills/           # Skill 类型与注册表
│   │       └── tools/            # Tool 协议、定义与注册表
│   ├── tools/                    # 可直接使用的内置工具
│   │   └── src/
│   │       ├── bash/             # Shell 执行与输出处理
│   │       ├── read-file.ts
│   │       ├── write-file.ts
│   │       └── edit-file.ts
│   ├── middleware/               # 可直接使用的内置中间件
│   │   └── src/
│   │       ├── context-compact/  # 上下文压缩
│   │       ├── tool-result/      # 工具结果管理
│   │       └── todo.ts           # Todo 状态管理
│   └── cli/                      # Commander + React Ink 终端应用
│       └── src/
│           ├── adapters/         # Core 事件到 UI 的适配
│           ├── commands/         # CLI 子命令
│           ├── config/           # 配置加载与中间件装配
│           ├── prompts/          # 系统提示词构建
│           └── ui/               # Ink 页面、组件与 hooks
├── package.json                  # Workspace 脚本与开发依赖
├── pnpm-workspace.yaml           # pnpm workspace 定义
├── tsconfig.json                 # TypeScript 基础配置
├── eslint.config.js              # ESLint 配置
├── vitest.config.ts              # Vitest 配置
├── commitlint.config.js          # Commitlint 配置
└── .prettierrc                   # Prettier 配置
```

各包构建后会生成 `dist/`，安装依赖后会生成 `node_modules/`；这些生成目录不属于源码结构，未在上图中列出。测试统一放在对应源文件同级的 `__tests__/` 目录中。

---

## 4. 核心配置说明

### 4.1 构建（tsup）

- CLI 入口：`packages/cli/src/index.ts`
- 输出格式：ESM（`"type": "module"`）
- Target：Node.js 20+
- 各包分别通过自己的 `tsup.config.ts` 构建到包内 `dist/`；CLI 产物会注入 `#!/usr/bin/env node` shebang，可直接作为可执行文件

### 4.2 代码规范

- **Prettier**：`semi: false`，`singleQuote: true`，`trailingComma: all`，`printWidth: 100`
- **ESLint**：启用 `recommended-type-checked` 规则集，依托 `tsconfig.json` 进行类型感知分析

### 4.3 Git 工作流

```
git commit
  ├── pre-commit   → lint-staged（ESLint --fix + Prettier 格式化暂存文件）
  └── commit-msg   → commitlint（校验提交信息格式）
```

Conventional Commits 类型枚举：`feat` / `fix` / `chore` / `docs` / `style` / `refactor` / `test` / `perf` / `ci` / `revert`

### 4.4 测试策略

- 测试目录与源文件**同级 colocate**（`__tests__/*.test.ts`）
- 单元测试覆盖：core、tools、middleware 与 CLI 配置等关键逻辑
- CI 阶段输出 lcov 覆盖率报告
- pre-commit 阶段**不强制跑测试**（避免影响提交速度），测试在 CI 中执行

### 4.5 CI 流水线（GitHub Actions）

```
push / PR → install → typecheck → lint → format:check → build → test:coverage
```

---

## 5. 开发流程

```bash
# 本地开发（watch 模式构建）
pnpm dev

# 本地测试 CLI
pnpm build && node dist/index.js

# 全局链接调试
pnpm link --global
mech --help

# 运行测试
pnpm test:watch

# 查看覆盖率
pnpm test:coverage
```

---

## 6. 依赖清单

### 运行时依赖

| 包          | 用途                   |
| ----------- | ---------------------- |
| `commander` | CLI 命令解析与路由     |
| `ink`       | React 驱动的终端 TUI   |
| `react`     | ink 的 peer dependency |
| `chalk`     | 终端文字着色           |
| `ora`       | 终端 Spinner 加载动画  |

### 开发依赖

| 包                                                    | 用途             |
| ----------------------------------------------------- | ---------------- |
| `typescript`                                          | TS 编译器        |
| `tsup`                                                | 打包构建         |
| `vitest`                                              | 测试框架         |
| `@vitest/coverage-v8`                                 | 覆盖率收集       |
| `ink-testing-library`                                 | ink 组件测试工具 |
| `eslint` + `typescript-eslint`                        | 静态分析         |
| `prettier`                                            | 代码格式化       |
| `simple-git-hooks`                                    | Git Hooks 管理   |
| `lint-staged`                                         | 暂存文件 Lint    |
| `@commitlint/cli` + `@commitlint/config-conventional` | Commit 信息校验  |

---

## 7. 初始化步骤

```bash
# 1. 初始化包管理
pnpm init

# 2. 安装运行时依赖
pnpm add commander ink react chalk ora

# 3. 安装开发依赖
pnpm add -D typescript tsup vitest @vitest/coverage-v8 \
  @types/node @types/react ink-testing-library \
  eslint @typescript-eslint/eslint-plugin @typescript-eslint/parser \
  prettier lint-staged simple-git-hooks \
  @commitlint/cli @commitlint/config-conventional

# 4. 激活 Git Hooks
pnpm prepare
```
