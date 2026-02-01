# cmdkit（精简版设计文档）：Schema-first 命令执行内核 + 文本路由 + phase 拦截器

## 1. 目标与边界

**目标**：提供可独立复用的 command/op 执行内核，支持 schema-first 校验、文本路由与 argv 解码；强调**优雅、可推理、热路径高效**，允许上层通过文档/lint 约束用法。

**提供**：`cmd(id)` builder、schema-first（input/output）、phase-based interceptor、结构化错误、可选观测钩子（emit/span）、tokenize+match+dispatch、argv adapter（默认可选 type-flag）。  
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
import type { StandardSchemaV1, StandardJSONSchemaV1 } from "@standard-schema/spec";

export type CmdErrorCode =
  | "E_CMD_NOT_FOUND"
  | "E_ARGV_PARSE"
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
    flags?: Array<{ name: string; alias?: string[]; type: "string" | "number" | "boolean"; description?: string; required?: boolean; negate?: boolean }>;
  };
}

export type AnyStdSchema = StandardSchemaV1<any, any>;
export type AnyStdJsonSchema = StandardJSONSchemaV1<any, any>;
export type InferOut<S extends AnyStdSchema> = NonNullable<S["~standard"]["types"]>["output"];

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
  input<T extends AnyStdSchema>(schema: T): CmdBuilder<InferOut<T>, O, S>;
  output<T extends AnyStdSchema>(schema: T): CmdBuilder<I, InferOut<T>, S>;

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
export type ParsedArgv = { flags: Record<string, unknown>; _: string[] };

export interface ArgvAdapter {
  parse(tokens: string[], cfg: {
    flags: Array<{ name: string; alias?: string[]; type: "string" | "number" | "boolean"; required?: boolean; negate?: boolean }>;
    allowUnknownFlags: boolean;
    typeFlagOptions?: unknown;
  }): ParsedArgv;
}

export interface TextConfig {
  triggers?: string[]; // 默认 [id]
  tokenize?: TextTokenizer;
  caseInsensitive?: boolean; // 仅影响 exec.execText(...) 的 trigger 匹配；Router 用 createRouter({ caseInsensitive: true })

  adapter?: ArgvAdapter; // 默认 type-flag
  flags?: Array<{ name: string; alias?: string[]; type: "string" | "number" | "boolean"; description?: string; required?: boolean; negate?: boolean }>;
  map?: (parsed: ParsedArgv) => unknown; // 默认 parsed.flags
  allowUnknownFlags?: boolean;           // 默认 false
  typeFlagOptions?: unknown;             // 透传给 type-flag
}
```

也支持 sugar：`text(mapFn)` 等价于 `text({ map: mapFn })`（适合 positionals 场景）。

当提供 `map` 且未显式设置 `flags` 时，默认视为“你接管了解析”，因此不会再从 input schema 自动推导 flags（避免必填字段导致 `--x` 必填的意外错误）。如需同时启用 flags + map，请显式提供 `flags: [...]`。

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

### 4.2.2 MCP/tool：显式 opt-in（`.mcp(...)`），与 cmd 共用 schema+handler

cmdkit 的“核心执行器”本质上就是 op：同一份 `input schema + handler` 可以同时用于：
- Text 指令：`.text(...)` + router
- MCP/tool calling：用 JSON Schema 暴露给模型（运行时仍走 cmdkit schema 校验）

推荐写法：把 schema 定义成常量，然后两边复用。

```ts
import * as v from 'valibot'
import { cmd } from '@pluxel/cmd'

const EchoInput = v.object({ msg: v.string() })

const echo = cmd('echo')
  .input(EchoInput)
  .mcp({
    title: 'Echo',
    description: 'Echo a message',
  })
  .doc({
    details: [
      'Text:',
      '- echo "hello world"',
      '',
      'Tool:',
      '- call `echo` with `{ "msg": "hello world" }`',
    ].join('\\n'),
  })
  .text((p) => ({ msg: String(p._.join(' ')) }))
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

`.mcp(...)` 是**显式声明**：只有你明确 opt-in 的 op 才会暴露 `exec.mcp` 元数据。
这让“可被 MCP 调用”变得更确定（不会有隐式推断/桥接行为）。

若你的 Standard Schema 无法自动转换为 JSON Schema，可在 `.mcp({ inputSchema: ... })` 中手动提供 `inputSchema` 覆盖。
若你希望在支持 Structured Outputs 的 MCP SDK/Registry 中暴露输出结构，可：
- 在 `.mcp({ outputSchema: ... })` 中手动提供输出 JSON Schema（可选，最明确）
- 或使用 `.mcp({ deriveOutputSchema: true })` 让 cmdkit 从 `.output(schema)` best-effort 派生 `meta.outputSchema`（可选；仍然需要你显式声明 `.output(...)`；对 transform/pipe 类 schema 可能不精确，建议手写 `outputSchema` 覆盖）

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
  tokenize(text: string): string[];
  dispatch(text: string, ctx?: ExecCtx): Promise<Result<unknown, CmdError>>;
  dispatchTokens(tokens: string[], ctx?: ExecCtx): Promise<Result<unknown, CmdError>>;
  match(text: string): { id: string; trigger: string; consumed: number; tokens: string[]; restTokens: string[] } | null;
  dispatchMatch(match: { id: string; trigger: string; consumed: number; tokens: string[]; restTokens: string[] }, ctx?: ExecCtx): Promise<Result<unknown, CmdError>>;
  list(): Array<{ id: string; triggers: string[] }>;
  check(exec: { id: string; meta?: { triggers: string[] } }, opts?: { triggers: string[] }, ignoreId?: string): { ok: true } | { ok: false; issues: Array<{ kind: string }> };
  // debug/introspection only (rendering belongs to upstream)
  helpIndex(): { list: Array<{ id: string; trigger: string }> };
  helpCommand(name: string): { id: string; triggers: string[] } | undefined;
}

export function createRouter(cfg?: {
  tokenize?: (text: string) => string[];
  caseInsensitive?: boolean;
}): Router;
```

---

## 5. Schema 与 argv 推导（build-time 一次性）

* 核心只要求 `StandardSchemaV1`：用于 input/output validate。
* 若 input schema 同时具备 `StandardJSONSchemaV1` 的 input JSON Schema 能力，且未手写 `text().flags`：

  * build-time 从 `type: object` 的 `properties` 推导 primitive flags（string/number/boolean）。
  * 复杂类型跳过（要求手写 flags 或用 positionals map）。
  * 若属性名 sanitize 后发生 flag name 冲突：build() 直接报错（要求显式提供 `text({ flags: [...] })` 来消歧）。
    原因：推导仅一次，运行期不触碰 schema/jsonschema，保证热路径稳定。

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
* `cmd.argv.parsed`

---

## 8. 设计取舍（简要）

* 不提供 `.timeout(ms)`：避免核心建 timer；上层用 `AbortSignal.timeout(ms)`/请求级 controller 实现更高效。
* 不提供 `.guard()` sugar：统一机制更优雅；策略通过 interceptor 工厂实现。
* 不导出 argv IR：build-time 编译成 parse+map 计划；运行期最短路径。
* 不做 fuzzy match：维护与性能更稳；建议由上层做更重的 UX。

以上定义了一个小而硬、可推理、易编译优化的命令内核：阶段少、语义点明确、unwind 逆序、state 私有通道、取消统一为 signal/deadline，既保持优雅也能把热路径压到最短。
