<INSTRUCTIONS>
下游仓库只做一件事：通过 symlink vendor 复用上游源码。

- 自举：`pnpm run bootstrap`（= `node setup.mjs bootstrap`）
- 上游挂载：`vendor/pluxel-template/*`（本地生成，默认 gitignore）
- 引擎挂载：`vendor/pluxel/*`（本地生成）
- 找不到上游时：设置 `PLUXEL_TEMPLATE_DIR` / `PLUXEL_DIR`

LLM/Codex 规则以模板为准：`vendor/pluxel-template/AGENTS.md`
</INSTRUCTIONS>
