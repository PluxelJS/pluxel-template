## pluxel-template（开箱即用、可复现）

这个仓库是 Pluxel 的「基础工作区」：提供共享的 `packages/*` 与可复用的 `plugins/*`，以及一个通用的 HMR Host 入口（`src/index.ts`）。

如果你是第一次读本仓库代码（或你在用 LLM 辅助阅读/改造），优先读：

1) `docs/REPO_MAP.md`
2) `HMR_WORKSPACE_PROFILES.md`

### 快速开始

> 依赖约定：本模板默认通过 `link:../pluxel/...` 引用 Pluxel 主仓库，所以请把 Pluxel 仓库放在与本仓库同级的 `../pluxel`。

1) 拉取：

- `git clone <repo> pluxel-template`

2) 安装依赖：

- `pnpm install`

（或一条命令：`pnpm bootstrap`）

> `pnpm bootstrap` 会先在 `../pluxel` 里构建 `@pluxel/core`/`@pluxel/hmr`，再安装本仓库依赖。

3) 启动：

- `pnpm dev`

默认只启动：

- 后端 HMR Host：`http://localhost:3000`（API 在 `/api/*`）

运行 demo 插件（可选）：

- `pnpm dev:demos`（使用 `pluxel.hmr.demos.jsonc` 加载 `docs/pluxel-demos/` 下的演示插件）

### 测试

- 默认（Turbo + cache）：`pnpm test`
- 全量（Vitest workspace）：`pnpm test:full`
- 跑单包：`pnpm --filter '<pkg-name>' test`

### 多仓工作区（下游产品仓库）

如果你在本地使用 `pluxel-workspace/` 多仓布局（`pluxel/`、`pluxel-template/`、`pluxel-chatbots/`、`pluxel-univer/` 同级），可在产品仓库直接运行：

- `pnpm run bootstrap`

它会通过 `scripts/workspace.sh` 自动挂载 `vendor/pluxel-template/{packages,plugins,agents}` 并完成依赖安装。

### 约定

- 启动入口在 `src/index.ts`。
- 运行态配置/持久化默认写入 `.pluxel/`（gitignore），避免污染工作区。

### Project-local Codex skills

本仓库把常用的工作流（Pluxel / `.d.ts` 入口解析）以项目内文件形式 vendoring 下来，见：

- `AGENTS.md`
- `agents/skills/README.md`
