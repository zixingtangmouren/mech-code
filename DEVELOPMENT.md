# 开发指南

本文档介绍如何在本地开发 mech-code 项目，以及如何发布新版本。

---

## 项目结构

```
packages/
├── @mech-code/shared   ← 跨包共享类型与工具函数（无依赖）
├── @mech-code/core     ← Agent Loop、Provider、工具系统、MCP、中间件
└── @mech-code/cli      ← 终端 UI（React Ink）+ 配置加载 + CLI 入口
```

包的依赖关系：`cli` → `core` → `shared`

---

## 环境准备

- Node.js ≥ 20
- pnpm ≥ 9（`npm install -g pnpm`）

```bash
# 克隆仓库
git clone https://github.com/your-username/mech-code.git
cd mech-code

# 安装依赖
pnpm install
```

---

## 本地开发

### 启动开发模式

```bash
# 所有包并行监听文件变动，自动重编译
pnpm dev
```

### 只启动某个包

```bash
pnpm --filter @mech-code/cli dev
pnpm --filter @mech-code/core dev
```

### 运行 CLI

先构建，再用 node 直接执行产物：

```bash
pnpm build
node packages/cli/dist/index.js chat
```

需要先在项目目录下创建 `.mech.json` 配置文件，或在 `~/.mech/config.json` 放置全局配置：

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

---

## 常用命令

| 命令              | 说明                         |
| ----------------- | ---------------------------- |
| `pnpm dev`        | 并行启动所有包的开发监听模式 |
| `pnpm build`      | 构建所有包                   |
| `pnpm test`       | 运行全部测试（Vitest）       |
| `pnpm test:watch` | 监听模式运行测试             |
| `pnpm typecheck`  | 全量 TypeScript 类型检查     |
| `pnpm lint`       | ESLint 检查                  |
| `pnpm lint:fix`   | 自动修复 lint 问题           |
| `pnpm format`     | Prettier 格式化              |

---

## 开发规范

- **代码注释必须使用中文**
- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范（commitlint 强制执行）
  - `feat:` 新功能
  - `fix:` Bug 修复
  - `refactor:` 重构
  - `docs:` 文档变更
  - `chore:` 构建/工具链相关
- 提交前会自动运行 lint-staged（ESLint + Prettier）
- 测试文件统一放在源文件同级的 `__tests__/` 目录下（`*.test.ts`）

---

## 版本发布

项目使用 [Changesets](https://github.com/changesets/changesets) 管理多包版本与发布。

### 第一步：记录变更

每次开发完成后，在提交代码前运行：

```bash
pnpm changeset
```

交互式流程：

1. 选择哪些包发生了变更（空格选中，回车确认）
2. 选择版本号类型：`patch`（修复）/ `minor`（新功能）/ `major`（破坏性变更）
3. 填写变更说明（会写入 CHANGELOG）

这会在 `.changeset/` 目录生成一个 Markdown 文件，**将它一并提交到 git**。

### 第二步：更新版本号

准备发版时，运行：

```bash
pnpm version-packages
```

这会：

- 根据所有未消费的 changeset 文件计算新版本号
- 更新各包的 `package.json` 版本字段
- 更新包间依赖版本（如 `core` 依赖的 `shared` 版本）
- 生成或追加 `CHANGELOG.md`
- 删除已消费的 `.changeset/*.md` 文件

提交这些变更：

```bash
git add .
git commit -m "chore: version packages"
```

### 第三步：发布

确保已登录 npm 并切换到官方 registry：

```bash
npm config set registry https://registry.npmjs.org
npm whoami  # 确认已登录
```

执行发布：

```bash
pnpm release
```

等价于 `pnpm build && changeset publish`，按依赖顺序自动发布：

```
@mech-code/shared  →  @mech-code/core  →  @mech-code/cli
```

发布成功后，给当前提交打 tag：

```bash
git push --follow-tags
```

---

## 包说明

### `@mech-code/shared`

跨包共享的类型定义与工具函数，无任何运行时依赖。包含：

- 所有 `AgentEvent` 事件类型定义
- `Message`、`Usage`、`ToolDefinition` 等核心类型
- `expandPath`、`levenshtein` 等工具函数

### `@mech-code/core`

核心 SDK，包含：

- `createAgent()` —— 创建 Agent 实例
- Agent Loop —— 多轮对话驱动逻辑
- Provider 系统 —— Anthropic / OpenAI / OpenAI Compatible
- 工具系统 —— `defineTool()`、内置工具（read_file、edit_file、bash 等）
- MCP 客户端 —— 接入外部 MCP 服务
- 中间件管道 —— 可插拔横切逻辑

### `@mech-code/cli`

终端界面（React Ink），包含：

- `mech chat` 命令入口
- TUI 组件（Header、MessageList、InputBox、Spinner、StatusBar）
- 配置加载（`~/.mech/config.json` + `.mech.json`）
- Slash 命令（`/help`、`/clear`、`/exit`）
