<INSTRUCTIONS>
## Project-local skills (portable)

本仓库把常用的 Codex/LLM workflow 以**项目内文件**形式 vendoring 下来：换台机器（没有全局 `$CODEX_HOME/skills`）也能直接用。

### 入口
- Skill 入口：`agents/skills/<skill-name>/SKILL.md`
- 只在需要时再打开 `references/*`（不要一次性读全量）

### Skills
- `pluxel`：插件/HMR/MCP/日志/测试/写插件 demo 参考
- `dts-resolver`：依赖包 `.d.ts` 入口解析（找接口/找类型/找声明入口）

### 触发规则
- 用户点名 skill（例如 “pluxel skill” / “dts-resolver”）→ 必须打开对应 `SKILL.md` 并按 workflow 执行
- 用户未点名但任务明显匹配 → 也必须使用对应 skill

### 约束（便于可复现）
1) 先读 `SKILL.md`；只在需要时再读 `references/*`
2) 优先使用仓库内脚本/命令（例如 `node scripts/resolve-dts.mjs ...`），不要写死本机路径
</INSTRUCTIONS>
