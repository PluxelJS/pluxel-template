# Project-local skills

这些 “skills” 用于给 Codex/LLM 提供固定的工作流与约定（不依赖机器上的全局 `$CODEX_HOME/skills` 安装）。

- `pluxel`: `agents/skills/pluxel/SKILL.md`
- `dts-resolver`: `agents/skills/dts-resolver/SKILL.md`

使用约定（保持高信噪比）：
- 先打开 `SKILL.md`，按顺序执行；只在需要时再打开 `references/*`
- 命令/路径以本仓库为准（例如 `node scripts/resolve-dts.mjs ...`）
