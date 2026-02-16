# @pluxel/cmd（内部代号：cmdkit）：TypeBox(JSON Schema)-first 命令执行内核 + 文本路由 + phase 拦截器

说明：本文用 “cmdkit” 指代 `@pluxel/cmd` 这套内核与 API（只是内部代号，避免和 `cmd()` builder 混淆）。

## 1. 目标与边界

**目标**：提供可独立复用的 command/op 执行内核，支持 schema-first 校验与文本路由（schema 派生参数 + 固定语法解析）；强调**优雅、可推理、热路径高效**，允许上层通过文档/lint 约束用法。

**提供**：`cmd(id)` builder、schema-first（input/output）、phase-based interceptor、结构化错误、可选观测钩子（emit/span）、tokenize+match+dispatch、schema-derived 文本语法（text）。  
**不提供**：平台/富文本/前缀解析、权限/限流存储、DI/HMR/插件生命周期、日志/追踪实现、核心内建 timer/timeout 生产。

---

## 2. 核心原则（少且硬）

1) **取消与超时统一由上层提供**：核心只消费 `AbortSignal` / `deadlineMs`（不创建 timer）。  
原因：核心更纯、更快；上层可实现“请求级一次超时”，避免“每命令一个 timer”。

2) **扩展点使用 phase-based interceptor，不用 `next()`**。  
原因：固定生命周期点易推理，且可编译成紧凑循环，热路径分配少。

3) **unwind（退出）阶段逆序执行**：`afterOutput`/`onError`/`finally` 逆序；`before`/`afterInput` 正序。  
原因：获得栈语义（先进入后退出），清理与观测更稳定。

4) **每个 interceptor 具备私有 state 通道**（由 `before` 产生，后续阶段复用）。  
原因：避免把状态塞进共享 ctx，减少耦合与运行期开销。

5) **各阶段能力边界写死**（短路/变换/恢复均受限）。  
原因：保持可推理性，避免“隐式控制流”滑回 middleware 复杂度。

---

## 3. 执行生命周期与阶段契约

命令执行自然生命周期：`candidate (unknown) -> input (validated) -> output (validated)`。

### 3.1 阶段定义（固定且少）
- `before(candidate)`：可拒绝、可改写 candidate、可短路直接返回 outputCandidate。
- `afterInput(input)`：观测（不允许改写 input；如需改写请放在 schema/handler 或 `before`）。
- `afterOutput(output)`：允许轻量变换 outputCandidate（如脱敏/envelope），**逆序执行**。
- `onError(err)`：默认只观测，**逆序执行**；是否允许恢复必须显式声明。
- `finally(summary)`：只清理与观测，**逆序执行**；禁止改写结果。

### 3.2 返回协议（最小且强约束）
- `before` 可返回：
  - `continue`（可带 `candidate` 替换 + `state`）
  - `shortCircuit(outputCandidate)`（跳过 handler，仍做 output validate + afterOutput + finally）
- `afterOutput` 可返回：
  - `transform(outputCandidate)` 或 `void`
- `onError`：
  - 默认 `void`
  - 若 interceptor 声明 `canRecover=true`，允许 `recover(outputCandidate)`（恢复后走 output validate + afterOutput + finally）
- `finally`：`void`

---

## 4. API（公开面尽量小）

### 4.1 `cmd(id)`：唯一 Builder（类型状态机约束误用）
- 不设置 `.input(...)`：默认 strict empty object（只接受 `{}`）。
- 必须设置 `.handle(...)` 才能 `.build()`（编译期约束）。
- 未启用 `.text(...)`：产物没有 `execText`。

```ts
import type { Static, TSchema } from '@sinclair/typebox';

export type CmdErrorCode =
  | "E_CMD_NOT_FOUND"
  | "E_TEXT_PARSE"
  | "E_INPUT_VALIDATION"
  | "E_OUTPUT_VALIDATION"
  | "E_FORBIDDEN"
  | "E_RATE_LIMITED"
  | "E_ABORTED"
  | "E_TIMEOUT"
  | "E_DEPENDENCY"
  | "E_INTERNAL";

export type CmdErrorKind = "expected" | "fault";

export class CmdError extends Error {
  code: CmdErrorCode;
  kind: CmdErrorKind;
  publicMessage: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export type ValidationIssue = {
  path?: (string | number)[];
  message: string;
  code?: string;
  meta?: Record<string, unknown>;
};

export interface ExecCtx {
  signal?: AbortSignal;
  deadlineMs?: number; // 可选：用于更好分类/观测；不要求核心创建 timer
  emit?(type: string, payload: Record<string, unknown>): void;
  span?<T>(name: string, attrs: Record<string, unknown>, fn: () => T | Promise<T>): Promise<T>;
  classifyError?: (e: unknown) => CmdError | undefined;
  onFault?: (payload: { id: string; err: CmdError; durationMs: number; recovered: boolean }) => void | Promise<void>;
}

export type Result<T, E = CmdError> =
  | { ok: true; val: T; err: null }
  | { ok: false; val: null; err: E };

export interface Executable<I, O> {
  readonly id: string;
  exec(value: unknown, ctx?: ExecCtx): Promise<Result<O, CmdError>>;
  execText?: (text: string, ctx?: ExecCtx) => Promise<Result<O, CmdError>>; // 仅 text 启用时存在
  meta?: {
    triggers: string[];
    params?: Array<{ name: string; type: "string" | "number" | "boolean" | "json" | "string[]" | "number[]" | "boolean[]" | "json[]"; description?: string; required?: boolean; negate?: boolean; short?: string }>;
  };
}

export type Schema = TSchema;
export type Infer<S extends Schema> = Static<S>;

export type PhaseResult<S> =
  | { kind: "continue"; state?: S; candidate?: unknown }
  | { kind: "shortCircuit"; state?: S; outputCandidate: unknown };

export type AfterOutputResult =
  | { kind: "transform"; outputCandidate: unknown }
  | void;

export type OnErrorResult =
  | { kind: "recover"; outputCandidate: unknown }
  | void;

export interface Interceptor<S = unknown> {
  /** 声明是否允许 recover；默认 false（保持可推理） */
  canRecover?: boolean;

  before?(ctx: ExecCtx, candidate: unknown): PhaseResult<S> | void | Promise<PhaseResult<S> | void>;

  afterInput?(ctx: ExecCtx, input: unknown, state: S): void | Promise<void>;

  /** 逆序执行；用于脱敏/envelope 等轻量变换 */
  afterOutput?(ctx: ExecCtx, output: unknown, state: S): AfterOutputResult | Promise<AfterOutputResult>;

  /** 逆序执行；仅当 canRecover=true 才允许返回 recover */
  onError?(ctx: ExecCtx, err: unknown, state: S): OnErrorResult | Promise<OnErrorResult>;

  /** 逆序执行；只清理/观测，不得改写结果 */
  finally?(ctx: ExecCtx, summary: { ok: boolean; durationMs: number; err?: CmdError }, state: S): void | Promise<void>;
}

type State = { hasHandle: boolean; hasText: boolean };

export interface CmdBuilder<I, O, S extends State> {
  input<T extends Schema>(schema: T): CmdBuilder<Infer<T>, O, S>;
  output<T extends Schema>(schema: T): CmdBuilder<I, Infer<T>, S>;
  validateInput(...fns: Array<(input: I, ctx: ExecCtx) => void | ValidationIssue | ValidationIssue[] | Promise<void | ValidationIssue | ValidationIssue[]>>): CmdBuilder<I, O, S>;
  validateOutput(...fns: Array<(output: O, ctx: ExecCtx) => void | ValidationIssue | ValidationIssue[] | Promise<void | ValidationIssue | ValidationIssue[]>>): CmdBuilder<I, O, S>;

  intercept<TState>(itc: Interceptor<TState>): CmdBuilder<I, O, S>;

  handle(fn: (input: I, ctx: ExecCtx) => O | Promise<O>): CmdBuilder<I, O, { hasHandle: true; hasText: S["hasText"] }>;

  text(cfg?: TextConfig): CmdBuilder<I, O, { hasHandle: S["hasHandle"]; hasText: true }>;

  build(this: CmdBuilder<I, O, { hasHandle: true; hasText: S["hasText"] }>): Executable<I, O>;
}

export function cmd(id: string): CmdBuilder<{}, unknown, { hasHandle: false; hasText: false }>;
```

### 4.1.1 流式（Streaming）/ 可观测（Observability）

cmdkit 不引入 Observable/事件协议：只提供 `ctx.emit(type, payload)`，上层自定义事件名与 payload，并决定如何渲染/转发（CLI 实时输出、MCP notification、日志/trace）。

**最适合场景**：长耗时批处理/搜索/索引——边处理边产出进度与部分结果，同时 `exec()` 仍返回最终汇总。

```ts
import { cmd } from '@pluxel/cmd'

const EVT = {
  PROGRESS: 'index.progress',
  CHUNK: 'index.chunk',
} as const

const index = cmd('index')
  .handle(async (_input, ctx) => {
    const items = ['a', 'b', 'c']
    for (let i = 0; i < items.length; i++) {
      ctx.emit?.(EVT.PROGRESS, { id: 'index', current: i + 1, total: items.length })
      ctx.emit?.(EVT.CHUNK, { id: 'index', chunk: { item: items[i] } })
    }
    return { indexed: items.length }
  })
  .build()

await index.exec({}, {
  emit: (type, payload) => {
    if (type === EVT.PROGRESS) console.error(payload)
    if (type === EVT.CHUNK) console.log((payload as any).chunk)
  },
})
```

建议（保持精炼 + 可组合）：
- 事件名由上层定义成常量（避免散落字符串），并尽量做“模块级 namespace”（例如 `index.progress`）。
- payload 保持 JSON 友好、短小；总是带 `id`，进度用 `{ current, total? }`，分片用 `{ chunk }`，日志用 `{ level?, message }`。
- `emit` 回调应当不抛异常（上层吞掉/降级），避免影响命令主流程。

### 4.2 Text 能力：`text()` 是唯一入口

原因：避免多入口（例如旧式 `.argv()`/`.command()`）导致的误用与语义分叉；text 相关能力全部收敛在 `text(cfg?)`。

```ts
// Enable text execution for a command.
// - cfg.triggers omitted => defaults to [id]
cmd('echo').text()
cmd('echo').text({ triggers: ['e', 'say'] })
```

解析规则（唯一且固定）：
- 触发词匹配：按 triggers（空格分词）做最长匹配。
- 解析输入：从 input JSON Schema（TypeBox schema 的 JSON 视图）派生参数表，并支持：
  - `--key value` / `--key=value`
  - `--key` 的常见别名：同一参数默认接受 kebab/camel/snake 风格（例如 `--user-id` / `--userId` / `--user_id`）。
  - `key:value` / `key=value`
  - short flags：默认从参数名自动派生（冲突则全部不生成），并支持：
    - `-c value` / `-c=value` / `-cVALUE`
    - `-abc`（仅 boolean bundling）
  - boolean 的 `--no-key`
- ParseBox tail（text-only）：
  - `text({ tail })` 仅影响 text 执行域：cmdkit 会把剩余文本交给 ParseBox 解析，并要求其返回“对象 patch”，再合并进真实 input（因此不会污染 MCP 的 input schema）。
  - cmdkit 会在 tail 文本末尾追加一个 `\\n`（把“行结束”当成换行终止符），因此 `Runtime.Until(['\\n'], ...)` 可用作 “read until end-of-line”。
  - tail 的起点：遇到 `--`（end-of-options sentinel）后立即开始；否则在第一个“非选项 token”处开始。
  - 为避免把 `--xxx` 误当成 flag：如果你的 tail 需要以 `--` 开头，必须显式写 `--` sentinel，例如 `echo -- --literal`.

### 4.2.1 文档字段：`doc()`（不占用 TextConfig）

cmdkit 的 doc 仅用于 **MCP/tool 与上游渲染的原材料**，本身不负责最终 help 文本渲染。

**核心建议**：
- 绝大多数情况只写 `description` +（可选）`details` 就够了；需要更友好的 help 时再补 `usage/examples`。
- `details`（Markdown）可以作为 **text + MCP** 共用的“唯一文档语言”。

```ts
export interface CmdDoc {
  description?: string;
  details?: string;
  usage?: string;
  examples?: string[];
}

cmd('ping')
  .doc({ description: 'Health check', usage: 'ping', examples: ['ping'] })
  .text()
  .handle(() => 'pong')
  .build()
```

### 4.2.2 MCP/tool：显式 opt-in（`.mcp(...)` / `.mcp()`），与 cmd 共用 schema+handler

cmdkit 的“核心执行器”本质上就是 op：同一份 `input schema + handler` 可以同时用于：
- Text 指令：`.text(...)` + router
- MCP/tool calling：用 JSON Schema 暴露给模型（运行时仍走 cmdkit schema 校验）

推荐写法：把 schema 定义成常量，然后两边复用。

```ts
import { obj, Type } from '@pluxel/cmd'
import { cmd } from '@pluxel/cmd'

const EchoInput = obj({ msg: Type.String() })

const echo = cmd('echo')
  .input(EchoInput)
  // `.mcp({ title })` defaults description from `doc.description` when omitted.
  // `.mcp()` defaults title to `id` and description from `doc.description`.
  .mcp({ title: 'Echo' })
  .doc({
    details: [
      'Text:',
      '- echo "hello world"',
      '',
      'Tool:',
      '- call `echo` with `{ "msg": "hello world" }`',
    ].join('\\n'),
  })
  .text()
  .handle(({ msg }) => msg)
  .build()

// MCP tool definition (name/description/inputSchema) is data-only and built-time derived.
// Registering/exporting the tool is up to upstream.
const meta = echo.mcp!
const tool = {
  name: meta.name,
  description: typeof meta.description === 'function' ? meta.description({ locale: 'en-US' }) : meta.description,
  inputSchema: meta.inputSchema,
  ...(meta.outputSchema ? { outputSchema: meta.outputSchema } : {}),
}
```

`.mcp(...)` / `.mcp()` 是**显式声明**：只有你明确 opt-in 的 op 才会暴露 `exec.mcp` 元数据。
这让“可被 MCP 调用”变得更确定（不会有隐式推断/桥接行为）。

若你需要对外暴露的 JSON Schema 与内部 schema 不同，可在 `.mcp({ inputSchema: ... })` 中手动提供 `inputSchema` 覆盖。
若你希望在支持 Structured Outputs 的 MCP SDK/Registry 中暴露输出结构，可：
- 在 `.mcp({ outputSchema: ... })` 中手动提供输出 JSON Schema（可选，最明确）
- 或使用 `.mcp({ deriveOutputSchema: true })` 让 cmdkit 从 `.output(schema)` 派生 `meta.outputSchema`（可选；仍然需要你显式声明 `.output(...)`）

#### 4.2.2.1 从 mcp-lite 这类 minimal MCP server 的设计取向借鉴的几个“桥接”要点

由于当前环境限制无法直接拉取 `fiberplane/mcp-lite` 源码逐行对照，这里总结的是“mcp-lite 这类 minimal MCP server 常见的设计取向”：
**data-only 的 tool 定义 + transport/middleware 在上层**，适合拿来约束我们在 cmdkit 之上的 MCP 适配层边界。

- **tool 定义纯数据**：cmdkit 只产出 `name/description/inputSchema/outputSchema?`；至于“把它注册到哪个 server / 用什么 transport”，完全由 upstream 决定。
- **Structured Outputs 优先**：当 `outputSchema` 存在时，把 cmdkit 的返回值作为“结构化输出”传给 MCP SDK（具体字段名以 SDK 为准），避免把 JSON 塞进字符串里。
- **取消/超时从 transport 贯穿**：把 MCP request 的取消信号映射到 `ExecCtx.signal`，把 request deadline 映射到 `ExecCtx.deadlineMs`；cmdkit 不创建 timer，但能做一致分类/观测。
- **middleware ≈ interceptor 组装**：像 mcp-lite 那样在 server 层做 middleware（鉴权/限流/日志/trace），在 cmdkit 层用 interceptor 做命令级语义（输入/输出 envelope、脱敏、recover）。

> mcp-lite 的 server 注册形态大致是 `server.tool(name, desc, { inputSchema, outputSchema }, handler)`。
> cmdkit 的 `exec.mcp` 刚好就是这份 `{ inputSchema, outputSchema? }` 的来源。

### 4.2.3 doc 可选 + i18n：允许函数

`doc()` 可完全不写；同时为了 i18n，允许传入函数形式：

```ts
const echo = cmd('echo')
  .input(EchoInput)
  .doc((ctx) => ({
    description: ctx.locale === 'zh-CN' ? '复读消息' : 'Echo a message',
  }))
  .mcp({
    title: (ctx) => (ctx.locale === 'zh-CN' ? '复读' : 'Echo'),
    description: (ctx) => (ctx.locale === 'zh-CN' ? '复读一段消息' : 'Echo a message'),
  })
  .handle(({ msg }) => msg)
  .build()

// export-time 选择语言（由 upstream 决定如何注册/渲染）
const meta = echo.mcp!
const tool = {
  name: meta.name,
  description: typeof meta.description === 'function' ? meta.description({ locale: 'zh-CN' }) : meta.description,
  inputSchema: meta.inputSchema,
  ...(meta.outputSchema ? { outputSchema: meta.outputSchema } : {}),
}
```

### 4.3 Router：精确匹配 + 轻量 help（数据生成）

原因：可预测与高性能；不引入 fuzzy 编辑距离。

```ts
export interface Router {
  add(exec: Executable<any, any>, opts?: { triggers: string[] }): void;
  set(exec: Executable<any, any>, opts?: { triggers: string[] }): void; // upsert by id
  remove(id: string): void;
  tokenize(text: string): Array<{ value: string; raw: string; start: number; end: number }>;
  dispatch(text: string, ctx?: ExecCtx): Promise<Result<unknown, CmdError>>;
  dispatchTokens(tokens: Array<{ value: string; raw: string; start: number; end: number }>, ctx?: ExecCtx): Promise<Result<unknown, CmdError>>;
  match(text: string): { id: string; trigger: string; consumed: number; tokens: Array<{ value: string; raw: string; start: number; end: number }>; restTokens: Array<{ value: string; raw: string; start: number; end: number }> } | null;
  dispatchMatch(match: { id: string; trigger: string; consumed: number; tokens: Array<{ value: string; raw: string; start: number; end: number }>; restTokens: Array<{ value: string; raw: string; start: number; end: number }> }, ctx?: ExecCtx): Promise<Result<unknown, CmdError>>;
  list(): Array<{ id: string; triggers: string[] }>;
  check(exec: { id: string; meta?: { triggers: string[] } }, opts?: { triggers: string[] }, ignoreId?: string): { ok: true } | { ok: false; issues: Array<{ kind: string }> };
  // debug/introspection only (rendering belongs to upstream)
  helpIndex(): { list: Array<{ id: string; trigger: string }> };
  helpCommand(name: string): { id: string; triggers: string[]; params?: Array<{ name: string; type: string }>; tail?: true; doc?: unknown } | undefined;
}

export function createRouter(cfg?: {
  caseInsensitive?: boolean;
}): Router;
```

---

## 5. Schema 派生的文本参数（build-time 一次性）

* 核心只要求 TypeBox schema（JSON Schema）：用于 input/output validate。
* `text()` 会在 build-time 从 input JSON Schema 派生参数表（用于解析与 help 输出）：
  * `type: object` 的 `properties` 中，派生 `params`（保留字段 `_` 禁止使用）。
  * boolean 自动支持 `--no-<name>`。
  * tail（ParseBox）是 text-only：`text({ tail })` 要求 ParseBox 返回对象 patch，并合并进真实 input。
  * tail 的起点由 `--` sentinel 或第一个“非选项 token”决定；为了把 `--xxx` 作为 tail 传入，必须写 `--` sentinel。

---

## 6. 执行器语义（可实现且高效）

### 6.1 exec(value, ctx) 热路径（无 next，紧凑循环）

1. 读取 `ctx.signal`/`ctx.deadlineMs`（仅用于检查/分类，不创建 timer）
2. `before` 正序：收集 `states[]`，可改写 candidate 或短路
3. input validate：失败收敛为 `err(E_INPUT_VALIDATION)`
4. `afterInput` 正序
5. handler
6. `afterOutput` 逆序（允许 transform）
7. output validate（对最终 outputCandidate）：失败收敛为 `err(E_OUTPUT_VALIDATION)`
8. `finally` 逆序

错误路径（对外统一返回 Result，不抛出异常）：

* 捕获 err（内部仍可用异常表达控制流与早退，边界处收敛为 Result）
* `onError` 逆序：若遇 recover（且允许），转入 afterOutput + output validate + finally，最终返回 `ok`
* 未 recover：最终返回 `err(CmdError)`，仍执行 `finally` 逆序

原因：逆序 unwind + state 通道，获得栈语义与可靠收尾；数组循环实现可 JIT 友好。

### 6.2 取消/超时分类（不生产 timeout）

* 若 `ctx.signal?.aborted`：优先 `E_ABORTED`，若可从 reason/deadline 推断为超时则 `E_TIMEOUT`。
* 若 `ctx.deadlineMs` 存在且 `now > deadlineMs`：可直接 `E_TIMEOUT`（即使 signal 未 abort）。
  原因：核心不管“何时触发”，但可做一致分类/观测。

---

## 7. 观测（可选，零依赖）

* `ctx.emit(type, payload)`：可选；payload 小而扁平。
* `ctx.span(name, attrs, fn)`：可选；用于包裹关键阶段。
  原因：不绑实现；不在热路径制造大对象。

推荐事件（实现内常量即可）：

* `cmd.exec.start/end/error/recovered`
  * `cmd.exec.end` 建议只发一次（finally 内），并携带 `{ ok, durationMs, code? }`（`code` 仅在失败时存在）
* `cmd.exec.fault`（仅当 `err.kind === "fault"`；用于告警/堆栈采集）
* `cmd.schema.input.ok/fail`
* `cmd.schema.output.ok/fail`（包括 recover 分支中的 output validate）
* （Text 参数解析事件可由上层自行定义；cmdkit 不强制内置）

---

## 8. 设计取舍（简要）

* 不提供 `.timeout(ms)`：避免核心建 timer；上层用 `AbortSignal.timeout(ms)`/请求级 controller 实现更高效。
* 不提供 `.guard()` sugar：统一机制更优雅；策略通过 interceptor 工厂实现。
* 不导出“中间 IR”：build-time 派生参数表并编译解析器；运行期最短路径。
* 不做 fuzzy match：维护与性能更稳；建议由上层做更重的 UX。

以上定义了一个小而硬、可推理、易编译优化的命令内核：阶段少、语义点明确、unwind 逆序、state 私有通道、取消统一为 signal/deadline，既保持优雅也能把热路径压到最短。
