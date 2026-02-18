---
name: pluxel
description: Use when working on Pluxel（插件系统与 demos、HMR/MCP、日志约定与 runtime logs、通过 @pluxel/test 写测试、或需要定位依赖包类型/声明文件 .d.ts）。Prefer one clear workflow; open references only when needed.
---

# pluxel（单入口 workflow）

## 准心（做 X 先读 Y）
- 写插件：demo 索引 → `references/plugins.md`
- 写/改测试：`references/testing.md`
- 写日志调用（callsite）：`references/logusage.md`
- 改 runtime logs（store / SSE / cursor 语义）：`references/runtime-logs-v1.md` → `references/logger.md`
- 用 MCP/HMR loopback（最后手段）：`references/agent-loopback-mcp.md`
- 用 OTLP Viewer MCP（查 traces/logs/metrics）：`references/otlp-viewer-mcp.md`
- 找依赖包类型/接口：`agents/skills/dts-resolver/SKILL.md` → `references/types.md`

## 工作流（按顺序）
1) 先找定义：workspace 代码用 `rg` / TS “Go to definition”；依赖包先解析 `.d.ts` 入口（不要盲搜 `node_modules`）。
2) 再选验证：能测就测（`@pluxel/test`）；只有在必须真实宿主（UI/HMR/log streams）时才启动 host；MCP loopback 是最后手段。
3) 写插件时：从 demo 目录复制最小片段；所有清理都绑定到 `ctx.effects`（避免 HMR 泄漏）。
4) 改日志相关时：
   - 改 callsite → 必须按 `references/logusage.md` 的“允许调用形式 + 错误传参规则”
   - 改 runtime logs → 必须按 `references/runtime-logs-v1.md` 的 V1 语义（epoch/seq/cursor/virtual streams）

## 快捷命令
```bash
# 先看看 repo 里有哪些可用脚本（避免猜不存在的命令）
pnpm -s run | rg -n "^(dev|hmr)|plugins-host|test"

# 一次性 agent 入口（适合 code agent / CI / 生成可读日志，不会一直 watch 挂住）
# 输出：
# - logs/hmr.llm.txt（LLM 友好精简日志）
# - logs/hmr.agent.summary.json（结构化摘要：ok / errors / idleTimedOut|stableTimedOut|shutdownTimedOut）
pnpm -s exec pluxel-hmr agent --clean --json
#（模板项目也可用脚本：`pnpm -s run hmr:agent`）
#
# 说明：
# - 默认是 state-based：warmup 后 drain 内部 batch 队列（不靠 timeout 判“稳定”）
# - 如需“安静窗口”语义再加：`--quiet-ms 250`（这属于时间语义，建议只在必要时启用）
# - `--timeout-ms` 同时作为 drain/stable/shutdown 的兜底超时（默认 10000ms；重项目可提高）
# - `--json` 输出是可机器解析的纯 JSON（运行期间 stdout 会被抑制，避免污染 JSON）
# - 若你在 workspace 里改了 `@pluxel/hmr` 的 CLI 源码，需在 `@pluxel/hmr` 包目录先执行 `pnpm build` 更新 dist（bin 默认优先加载 dist）。

# 依赖类型入口（.d.ts）
node scripts/resolve-dts.mjs <pkg> --cwd <dir> [--importer <file>]

# 搜索仓库符号
rg -n "SymbolName\\b" src packages plugins

# demo-only 类型检查（选择存在的一个）
pnpm exec tsc -p docs/pluxel-demos/tsconfig.json
pnpm exec tsc -p packages/plugins/host/src/demo/tsconfig.json

# 测试 / 宿主（按 repo 实际脚本选择）
pnpm test
pnpm dev
pnpm dev:demos
pnpm --filter @pluxel/plugins-host hmr
```

## 参考（按需打开）

- 插件：`references/plugins.md`
- 测试：`references/testing.md`
- 日志：`references/logusage.md` / `references/logger.md`
- 类型：`references/types.md`
- MCP：`references/agent-loopback-mcp.md`
- OTLP Viewer：`references/otlp-viewer-mcp.md`
