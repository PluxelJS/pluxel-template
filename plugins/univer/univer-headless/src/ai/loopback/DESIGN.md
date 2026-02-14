# Univer Loopback Kernel (Headless) — Design

## 1. Goal

Provide a **single, stable, observable** backend-only loopback runner that edits a Univer workbook via Ax (`@ax-llm/ax`) + MCP tools.

Priorities:
- **Accuracy first**: never guess; writes must be verified (via targeted reads, or write tools with `readback`).
- **Predictable environment**: no “runtime knobs” from the UI; same toolset and policy every run.
- **LLM-readable code**: explicit phases, small modules, strong signatures, minimal branching.
- **Observability-first**: OpenTelemetry spans/events/metrics for every run/attempt/tool call.

Non-goals:
- Frontend UX, chat UI, streaming UI.
- Model/provider routing policies (handled by LLMHub).
- Backward compatibility with older loopback “modes/knobs”.

---

## 2. Contract (Public API)

The kernel exposes one entry:

- `runUniverAxLoopback(ai, bridge, input, { otel? }) -> { ok, summary|error, stats, rounds }`

Input is intentionally minimal:
- `instruction`
- `scopes` (`read`, optional `write`, `current`)
- `contexts.selections` (optional previews to reduce bootstrap reads)

The kernel **does not** accept `mode/maxRounds/toolPolicy/limits/contract` from callers.

---

## 3. Execution Phases (Strict, Small)

1) **Normalize**
   - Normalize/validate A1 scopes.
   - Choose `current`, `readScopes`, `writeScopes`.

2) **Build Environment**
   - Create toolset (minimal MCP groups by default; add structure/style only when instruction suggests it).
   - Build tool index text.
   - Prepare loop limits for bootstrap preview.

3) **Bootstrap Context**
   - Build “context pack” (small TSV previews) using:
     - frontend `contexts.selections[].selection.display` when available
     - otherwise read via the backend `readRangeDisplay` helper (scoped + cached)

4) **Run Iterative Attempt Flow (AxFlow)**
   - Editor agent executes tool calls until it claims `done=true`.
   - Post-check enforces invariants (write → must read after write).
   - QA agent runs with **read-only tools**; low confidence produces feedback.
   - Feedback triggers another attempt, bounded by fixed budgets.

5) **Finalize**
   - Return `{ ok, summary|error, stats, rounds }`.

---

## 4. Policy (Fixed)

This repo intentionally fixes these to avoid drift across UI/service versions:
- Tool groups: base `core,data,sheet` (auto-add `structure`/`style` when needed)
- Default budgets: `maxStepsTotal=80`, `maxAttempts=2`, `maxStepsPerAttempt=40`
- Auto bump (safe heuristic): for "data work" tasks with already-narrow scopes, budgets may increase (e.g. `maxStepsTotal=120`)
- Dev override: `UNIVER_LOOPBACK_MAX_STEPS_TOTAL=120`
- QA threshold: `confidence >= 0.7`
- Optional dev switches:
  - `UNIVER_LOOPBACK_PROMPT=full` (default is compact)
  - `UNIVER_LOOPBACK_QA=off` (default is auto)

---

## 5. Observability (OTel)

Spans/events/metrics are emitted at these levels:
- Root: `univer.loopback`
- Attempt events: `univer.attempt`
- Tool spans per call: `univer.tool`
- Ax step events: `ax.functions`
- Metrics: `univer.tool.calls`, `univer.tool.errors`, `univer.tool.latency_ms`, `univer.loopback.attempts`

The **service** layer wraps requests with `univer.loopback.request` and connects LLM fetch spans.

---

## 6. File Map

- `kernel.ts`: end-to-end orchestrator (phases)
- `attempt-flow.ts`: AxFlow iterative loop (Editor + QA + feedback)
- `programs.ts`: Editor/QA agent definitions (signatures + prompts)
- `policy.ts`: fixed budgets + groups + thresholds
- `prompt.ts`: prompt builders (tool index + context pack)
- `tools.ts` / `tool-wrap.ts`: tool assembly + OTel wrappers + function errors
- `context-pack.ts`: bootstrap preview text builder
- `limits.ts`: bootstrap read clip limits
- `otel.ts`: OTel helpers + instruments
