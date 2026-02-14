# 依赖类型定位（.d.ts 入口优先）

当任务是“找接口/类型定义/声明入口”，先拿到正确的 `.d.ts` 入口，再做 symbol 查找；不要在 `node_modules` 里盲搜。

## 1) 依赖包：先解析 `.d.ts` 入口

用项目内脚本（见 `agents/skills/dts-resolver/SKILL.md`）：

```bash
node scripts/resolve-dts.mjs <pkg> --cwd <importing-package-dir> [--importer <file>]
```

Tips：
- 不确定解析上下文就加 `--importer <path/to/importer.ts>`（解析更准）
- 有些包不带 `.d.ts`：脚本会在 stderr 提示，并在 stdout 输出“能解析到的最佳入口”
- 拿到入口文件后：打开它，顺着 re-export 找到真实定义，再用 `rg` 定位 symbol

## 2) workspace 源码：不要用 dts-resolver

类型如果就在本仓库：
- 直接 `rg`：`src/**`、`packages/**/src`、`plugins/**/src`（或 TS “Go to definition”）
- 行为验证优先写测试：`references/testing.md`
