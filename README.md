## pluxel-template（开箱即用、可复现）

这个模板把 `plugins/chatbots/` 作为 **git submodule** 固定到一个 commit，确保工作区依赖与 HMR 扫描内容可复现。

### 快速开始

> 依赖约定：本模板默认通过 `link:../pluxel/...` 引用 Pluxel 主仓库，所以请把 Pluxel 仓库放在与本仓库同级的 `../pluxel`。

1) 拉取（推荐带 submodule）：

- `git clone --recurse-submodules <repo> pluxel-template`

如果你已经 clone 了：

- `git submodule update --init --recursive`

2) 安装依赖：

- `pnpm install`

（或一条命令：`pnpm bootstrap`）

> `pnpm bootstrap` 会先在 `../pluxel` 里构建 `@pluxel/core`/`@pluxel/hmr`，再安装本仓库依赖。

3) 启动：

- `pnpm dev`

默认只启动：

- 后端 HMR Host：`http://localhost:3000`（API 在 `/api/*`）

需要同时启动 Univer 前端时：

- `pnpm dev:full`
  - 后端 HMR Host（默认使用 `univer` profile）：`http://localhost:3000`（API 在 `/api/*`）
  - Univer 前端（Vite）：`http://localhost:5174`（通过代理访问 `/api/*`）

### 约定

- `plugins/chatbots/` 是 submodule：用 `git submodule status` 查看固定版本；更新时请显式 `git -C plugins/chatbots pull` + 在主仓库提交 gitlink 变更。
- 启动入口在 `src/index.ts`。
- 运行态配置/持久化默认写入 `.pluxel/`（gitignore），避免污染工作区。
