# Univer headless AI: code map

This folder implements the Univer → LLM “loopback editor” in layered modules.

## Layers

1) **Bridge (workbook adapter)**
- `bridge.ts`: minimal, synchronous workbook operations (list/read/write/clear) + a generic `call()` dispatcher.

2) **Tools (MCP + presets)**
- `mcp/`: tool catalog and implementations (data/structure/sheets/style).
- `ax-params.ts`: JSON schema helpers for Ax tool parameters.

3) **Loopback executor (Ax + iterative processing)**
- `loopback/kernel.ts`: public entrypoint `runUniverAxLoopback()` (orchestrates phases; should stay readable).
- `loopback/tools.ts`: build tool list + stats + helpers.
- `loopback/tool-wrap.ts`: tool wrapper that turns failures into `AxFunctionError` (arg-correction) and emits OTel spans/metrics.
- `loopback/attempt-flow.ts`: AxFlow iterative processing / feedback loop (Editor + QA).
- `loopback/programs.ts`: editor + QA agent signatures/programs.
- `loopback/policy.ts`: fixed budgets + tool groups (no UI knobs).

## Observability

- `loopback/otel.ts`: OTel types + instruments names and helpers.
- Exported spans/metrics are documented in `plugins/univer/AI_LOOPBACK.md`.
