# Multi-repo layout（产品仓库 + pluxel-template 作为上游）

目标：把产品向代码（例如 Chatbots / Univer）放在各自独立仓库中；共享的 `packages/*` / 通用 `plugins/*` 留在 `pluxel-template`。产品仓库通过 **git submodule** 引入 `pluxel-template`，开发产品时如需改上游，直接在 submodule 里改并向上游提 PR。

如果你在产品仓库里使用 LLM 辅助阅读/改造，建议先读上游的结构说明：
- `vendor/pluxel-template/docs/README.md`
- `vendor/pluxel-template/docs/REPO_MAP.md`

## 推荐目录结构

```
pluxel-chatbots/              # 产品仓库（workspace root）
  vendor/pluxel-template/     # git submodule（上游）
  plugins/                    # 产品自己的 plugins（或按你现有结构）
  apps/                       # 产品自己的 apps（可选）
  package.json
  pnpm-workspace.yaml
  pluxel.hmr.jsonc            # 产品自己的 HMR 配置（roots 包含 vendor + 本地）
  src/host.ts                 # 产品自己的 host 入口（可选）
```

## 初始化一个产品仓库（示例）

1) 添加上游 submodule：

```bash
git submodule add https://github.com/ahdg6/pluxel-template.git vendor/pluxel-template
git submodule update --init --recursive
```

2) `pnpm-workspace.yaml` 把上游 packages/plugins 纳入 workspace：

```yaml
packages:
  - plugins/**
  - apps/**
  - vendor/pluxel-template/packages/**
  - vendor/pluxel-template/plugins/**
  - '!vendor/pluxel-template/plugins/native/napi-rs/*__*'
  # migration-safety: avoid duplicate product packages while template still contains them
  - '!vendor/pluxel-template/plugins/chatbots/**'
  - '!vendor/pluxel-template/plugins/univer/**'
```

3) 产品仓库根 `package.json` 提供 `pluxel` / `turbo` / `typescript` 等工具链依赖。

> 注意：`pluxel-template` 本身的根 `package.json` 不会参与你的 workspace root；工具链依赖需要在产品仓库根声明一份（可先复制模板根的依赖，再按需裁剪）。

4) 产品仓库根放一份 `pluxel.hmr.jsonc`，把 roots 指向 vendor + 本地：

- vendor 侧：`vendor/pluxel-template/packages`, `vendor/pluxel-template/plugins/*`
- 本地侧：你自己的 `plugins/*` / `packages/*`

5) Host 入口：

- 直接复用上游：`node --conditions=@pluxel/hmr vendor/pluxel-template/src/index.ts`
- 或在产品仓库自定义（例如需要额外 Vite 插件/seed 逻辑），自己写 `src/host.ts` 并在脚本里跑它。

## 上游改动的协作方式

- 产品仓库里改 `vendor/pluxel-template/*` → 在 submodule 内 `git commit` → push 到 `pluxel-template` 远端 → 提 PR
- 产品仓库本身只需要更新 submodule 指针（gitlink）到你想依赖的上游 commit
