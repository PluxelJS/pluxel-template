# Logger / Runtime Logs（入口）

- 改 `logger.*` 调用（callsite）→ `references/logusage.md`
- 改 runtime logs（store / range / follow / cursor / SSE）→ `references/runtime-logs-v1.md`

深度参考（只在批量审计时打开）：`references/logusage.full.md`

## 判断你在改哪一层

- 只改 callsite：按 `references/logusage.md`，到此为止
- 改 runtime logs：按 `references/runtime-logs-v1.md`，并守住不变量

## 1) Runtime Logs V1 (UI/tools consumption)

Use `ensurePluxelLogging()` once in the host entry:
- It configures LogTape if not configured yet, and enables the runtime logs sink by default.
- If you need the exact option shape, search in the repo (don’t guess):
  - `rg -n "ensurePluxelLogging|RuntimeLogSinkOptions" -S .`

Key invariants (don’t break):
- append-only per epoch; `seq` increases within an epoch; `epoch` increments on reset.
- cursor is **scan cursor**, not “returned rows”: `range.nextSeq` = “continue scanning from here”.
- `plugin:<id>` / `context:<x>` are **virtual views** backed by the `default` store (no per-plugin store explosion).

HTTP API (mounted under `/api/logs`):
- `GET /api/logs/v1/streams/:id/range` (cursor scanning semantics)
- `GET /api/logs/v1/streams/:id/follow` (SSE: always starts with `reset`, then catch-up, then append; may emit `gap`)

## 2) Writing logs (non-negotiables)

Default: use `ctx.logger` (do not create ad-hoc loggers in plugins).

If you need the exact “allowed call forms / audit rules / footguns”, open:
- `references/logusage.md`

Pick the call form by intent:
- human-only text: tagged template: ``logger.info`ready ${id}`` (no structured fields)
- queryable fields: `logger.info("loaded {id}", { id })` or `logger.with({ id }).info\`loaded\``
- expensive work: lazy callback: `logger.debug((l) => l\`snapshot ${expensive()}\`)`
- expensive properties: `logger.debug("ctx {*}", () => ({ meta: expensiveMeta() }))`

Error rules (formatter-controlled):
- never interpolate/format errors in the message.
- always pass the raw error object under key **exactly** `error` or `err`:
  - `logger.error("execute failed", { error })`

Debug channel:
- category fixed: `["pluxel","debug"]`
- topic in `record.properties.debugTopic` via `ctx.logger.getDebugChannel("pluxel:hmr:...")`

## 3) When changing logger code

If you touch store/range/follow semantics:
- re-check cursor invariants and the “virtual views” mapping.
- search for callers of `/range` and `/follow` (frontend + MCP usecases) and update together.
