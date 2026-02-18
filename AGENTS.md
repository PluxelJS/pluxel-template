<INSTRUCTIONS>
## LLM/Codex 工作流（高信噪比）

- 默认做法：先用 `rg`/跳转定位定义；改动尽量小且可验证；优先一次性命令（避免常驻 watch 卡住 agent）

## Skills（可选，用于固定工作流）

- 可用 skills：`pluxel`（插件/HMR/MCP/日志/测试）/ `dts-resolver`（解析依赖包 `.d.ts` 入口）
- 入口：`agents/skills/<skill-name>/SKILL.md`
- 触发规则：用户点名 skill 或任务明显匹配 → 必须打开对应 `SKILL.md` 并按 workflow 执行
- 只在需要时再打开 `references/*`（不要一次性读全量）

## Agent-friendly HMR（一次性，不常驻 watch）

- `pnpm -s run hmr:agent`（= `pluxel-hmr agent --clean --json`）

## 约束（便于可复现）
1) 先读 `SKILL.md`；只在需要时再读 `references/*`
2) 优先使用仓库内脚本/命令（例如 `node scripts/resolve-dts.mjs ...`），不要写死本机路径
</INSTRUCTIONS>
