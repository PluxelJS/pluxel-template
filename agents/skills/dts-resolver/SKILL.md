---
name: dts-resolver
description: Resolve TypeScript declaration entry files (.d.ts) for an import/dependency (oxc-resolver). 适用于“找接口/找类型定义/找声明文件(.d.ts) 入口”这类任务（尤其是 pnpm/monorepo）。
---

# dts-resolver (project-local)

## Quick workflow

1) 从代码里确定 module specifier（例如 `import type { Foo } from "some-pkg"` → `some-pkg`）。
2) 用本仓库脚本解析声明入口：`node scripts/resolve-dts.mjs <specifier> ...`
3) 打开解析出来的 `.d.ts`，顺着 re-export 找到真实定义。
4) 用 `rg` 在包含目录里定位具体 symbol。

## Commands

### Resolve a package’s `.d.ts` entry

```bash
node scripts/resolve-dts.mjs some-pkg
node scripts/resolve-dts.mjs some-pkg --cwd plugins/data/kv
node scripts/resolve-dts.mjs some-pkg --cwd plugins/data/kv --importer plugins/data/kv/src/index.ts
```

### Find a specific exported symbol

```bash
rg -n --hidden --no-ignore -S "export (interface|type) Foo\\b|interface Foo\\b|type Foo\\b" /abs/path/to
```

## Notes

- 这个脚本只负责 “specifier → 声明入口路径”，不理解 TS symbol；拿到入口后再用 `rg`/编辑器跳转。
- 输出：把解析到的入口路径打印到 stdout；如果没有 `.d.ts` 会在 stderr 打 warning（stdout 仍会给出最佳可解析入口）。
- specifier 可以是子路径（例如 `pkg/subpath` / `@scope/pkg/subpath`）；不确定解析上下文时加 `--importer`。
- 如果包不带 types，会尝试 `@types/<pkg>`；仍失败则打印可解析到的最佳非 `.d.ts` 入口并提示。

复制到别的仓库时（最小清单）：
- 复制 `scripts/resolve-dts.mjs`
- 确保依赖存在：`dts-resolver`、`oxc-resolver`
