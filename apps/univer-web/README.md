# `pluxel-univer-web`

Univer 的独立前端（Vite/React）。

## 开发

- 一键：在仓库根目录运行 `pnpm dev`
- 单独启动前端：`pnpm --filter pluxel-univer-web dev`

前端默认通过 Vite proxy 把 `/api/*` 转发到后端 HMR Host（默认 `http://localhost:3000`）。

可选环境变量：

- `PLUXEL_HMR_ORIGIN`: 覆盖后端地址（例如 `http://localhost:3000`）

