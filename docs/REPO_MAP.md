# Repo Map（精炼版）

目标：让读代码的人快速建立正确心智模型（“入口在哪 / 配置在哪 / 代码在哪”）。

## 这是什么

`pluxel-template` 是上游基础工作区：

- 共享库：`packages/*`
- 通用插件：`plugins/*`
- Host 入口：`src/index.ts`
- 项目内 LLM workflows：`agents/*`（入口 `AGENTS.md`）

下游产品仓库通常把本仓库以 **symlink vendor** 的方式挂载到 `vendor/pluxel-template/*`（由 `node pluxel-template/setup.mjs link` 维护），下游只维护自己的 `src/*` 入口与 `pluxel.hmr.jsonc`。

## 从哪开始读（最短路径）

1) `README.md`（怎么跑）
2) `src/index.ts`（Host 入口）
3) `pluxel.hmr.jsonc` + `HMR_WORKSPACE_PROFILES.md`（HMR/workspace 语义）
4) 写插件看 demo：`docs/pluxel-demos/*`

## 目录速查

- `packages/*`：可复用库（例如 `packages/cmd/*`）
- `plugins/*/*`：插件包（是否可被 HMR 加载的判定见 `HMR_WORKSPACE_PROFILES.md`）
- `scripts/*`：开发/doctor 工具
- `agents/*`：LLM 工作流与约束（入口 `AGENTS.md`）
