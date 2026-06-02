# mech-code

一个类似 Claude Code 的终端 CLI 工具，由 LLM 驱动。

## 项目结构

```
docs/ # 记录了项目过去的一些设计文档
packages/
  core/    # 核心逻辑：agent、provider、tools、mcp、middleware 等
  cli/     # 命令行入口，基于 React Ink 构建 TUI 界面
  shared/  # 跨包共享的工具函数与类型
```

## 常用命令

```bash
pnpm dev          # 并行启动所有包的开发模式
pnpm build        # 构建所有包
pnpm test         # 运行测试
pnpm test:watch   # 监听模式运行测试
pnpm typecheck    # 类型检查
pnpm lint         # lint 检查
pnpm lint:fix     # 自动修复 lint 问题
```

## 开发规范

- **代码注释必须使用中文书写**
- 提交信息遵循 Conventional Commits 规范（commitlint 强制执行）
- 代码提交前会自动运行 lint-staged（ESLint + Prettier）
- 使用 pnpm workspace 管理 monorepo，包间依赖通过 workspace 协议引用
- 测试框架为 Vitest，测试文件统一放在源文件同级的 `__tests__/` 目录下（`__tests__/*.test.ts`）
- **写完代码后一定要执行一下 pnpm typecheck、pnpm lint、pnpm test、pnpm build 指令进行测试**
