# Repo Map（给未来的 LLM / 新同学）

这份文件的目标：让读代码的人在 **不通读全仓库** 的情况下，快速建立对本 repo 的正确心智模型（“什么在哪 / 从哪开始读 / 改哪里不会踩雷”）。

## 这是什么仓库

`pluxel-template` 是一个 **上游基础工作区**：

- 提供共享的 `packages/*`（可复用库）
- 提供通用的 `plugins/*`（按领域分组的插件集合）
- 提供一个通用的 HMR Host 入口（`src/index.ts`）
- 提供项目内的 Codex/LLM workflows（`agents/*`）

产品向仓库（例如 chatbots/univer）通常作为独立仓库存在，并在本地多仓工作区里把本仓库“挂载”进去（例如 `vendor/pluxel-template` 下只 symlink `packages/` / `plugins/` / `agents/` 与 `AGENTS.md`），然后只在下游仓库里维护：

- 自己的 host 入口（例如 `src/host.ts`）
- 自己的 `pluxel.hmr.jsonc`（workspace roots/profile enabled 集合）
- 自己的 seed config（例如 `default.json`）

## 读代码推荐顺序（最少路径）

1) 运行入口与启动方式
- `README.md`
- `scripts/dev.mjs`
- `src/index.ts`

2) HMR 工作区是如何“发现插件包 + 选包 + 启动”的
- `pluxel.hmr.jsonc`
- `pluxel.hmr.discovered.jsonc`（生成产物：运行 `pnpm hmr:doctor` / `pnpm doctor` 后生成；只用于“有哪些可选包名”，不参与运行时）
- `HMR_WORKSPACE_PROFILES.md`（语义解释最权威）

3) 插件怎么写（看最小但完整的范例）
- `docs/pluxel-demos/README.md`
- `docs/pluxel-demos/*.ts`

4) 你要找的“功能代码”通常在哪
- 通用库：`packages/*`
- 通用插件：`plugins/*/*`
- Host 相关：`src/*` + `scripts/*`

## 目录约定（如何快速定位）

### `packages/*`
可复用库（“被插件依赖的基础能力”）。

示例：
- `packages/cmd/*`：命令/协议相关（设计文档：`packages/cmd/DESIGN.md`；用法：`packages/cmd/USAGE.md`）

### `plugins/*`
插件包（每个包都是一个可被 HMR 加载的 workspace package）。

分组目录是语义分区，不是技术边界：
- `plugins/ai/*`
- `plugins/data/*`
- `plugins/infra/*`
- `plugins/render/*`
- `plugins/func/*`
- `plugins/native/*`
- `plugins/builtin/*`（通常以 dist 作为 builtin baseline 预加载）

一个 workspace package 被视为 “可被 HMR 加载的插件包” 的最小判定条件见 `HMR_WORKSPACE_PROFILES.md`（核心点：`package.json.exports["."]["@pluxel/hmr"]`）。

### `agents/*`
项目内的 LLM 工作流与“参考语义”。如果你需要知道某类变更的约束（例如日志调用形式、runtime logs 语义、测试方式），从这里开始。

- 总入口：`AGENTS.md`
- Pluxel workflow：`agents/skills/pluxel/SKILL.md`

## “改哪里”最不容易引入连锁反应

- 只改某个插件行为：优先改对应 `plugins/<group>/<pkg>/src/*`
- 调整 HMR 选包/roots：优先改 `pluxel.hmr.jsonc`（并运行 `pnpm exec pluxel hmr doctor` 验证）
- 调整启动参数/多进程 dev 体验：优先改 `scripts/*`

## 常用定位命令（给人/LLM 都友好）

```bash
# 通过包名找入口
rg -n "\"name\": \"pluxel-plugin-" plugins -S

# 找某个插件的 HMR 入口（exports 条件）
rg -n "\"@pluxel/hmr\"" plugins packages -S

# 快速验证 HMR 配置是否自洽
pnpm -s exec pluxel hmr doctor
```
