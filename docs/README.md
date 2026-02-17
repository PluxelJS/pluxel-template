# Docs index

- `docs/REPO_MAP.md`：仓库地图（给 LLM / 新同学）
- `docs/MULTI_REPO.md`：产品仓库如何以 submodule 方式引入模板
- `HMR_WORKSPACE_PROFILES.md`：HMR profile/config 的权威语义说明
- `docs/pluxel-demos/README.md`：插件 demo（复制改写用）

## Start here（第一次读这套代码）

按这个顺序读，能显著减少“理解了某个文件但整体错用”的概率：

1) `docs/REPO_MAP.md`
2) `HMR_WORKSPACE_PROFILES.md`（尤其是 “profile.enabled ≠ 运行时 enabled”）
3) `pluxel.hmr.jsonc`（你当前 profile 的 roots/enabled/builtin）
4) `pluxel.hmr.discovered.jsonc`（可选：运行 `pnpm doctor` 后生成，给你/LLM 作为可选包名清单）

常用命令：

```bash
pnpm doctor
pnpm dev
pnpm dev:demos
```
