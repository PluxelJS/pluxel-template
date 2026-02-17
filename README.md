## pluxel-template

上游基础工作区：共享 `packages/*`、通用 `plugins/*`、Host 入口 `src/index.ts`、LLM workflows `agents/*`。

先读：
- `docs/REPO_MAP.md`
- `HMR_WORKSPACE_PROFILES.md`

### 本仓库启动（最短）

前置：`pnpm`，以及一个本地 `pluxel` 仓库（默认放在 `../pluxel`，或设置 `PLUXEL_DIR=/path/to/pluxel`）。

- `pnpm bootstrap`（内部执行 `node setup.mjs bootstrap-template`）
- `pnpm dev`

### 下游仓库如何复用上游源码（精简）

下游通过 symlink 挂载 `vendor/pluxel-template/*`，由 `node pluxel-template/setup.mjs link|bootstrap` 维护（下游仓库通常提供 `setup.mjs` wrapper）。

创建一个新的下游样板：
- `node setup.mjs init ../my-downstream`

### LLM / Codex

- 入口：`AGENTS.md`
- skills：`agents/skills/*`
