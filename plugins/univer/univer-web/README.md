# `pluxel-univer-web`

Univer 的独立前端（Vite/React）。

## 开发

- 后端（默认 `dev` profile）：在仓库根目录运行 `pnpm dev`
- 一键全量（后端 `univer` profile + 前端）：`pnpm dev:univer`（`dev:full` 仍可用）
- 单独启动前端：`pnpm --filter pluxel-univer-web dev`（需另开一个终端启动后端）

如果你是单独启动前端，推荐后端用 `univer` profile：

- `PLUXEL_HMR_PROFILE=univer pnpm dev`

前端默认通过 Vite proxy 把 `/api/*` 转发到后端 HMR Host（默认 `http://localhost:3000`）。

可选环境变量：

- `PLUXEL_HMR_ORIGIN`: 覆盖后端地址（例如 `http://localhost:3000`）
