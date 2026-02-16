# @pluxel/cmd — Usage

`@pluxel/cmd` is a schema-first command runtime:
- `input/output` validation via **TypeBox (JSON Schema)**
- text commands via a **single schema-derived flag parser**
- optional ParseBox-powered tail DSL (text-only patch)

Notes:
- Object schemas are treated as **strict** by default (unknown keys rejected) when `additionalProperties` is omitted. To allow unknown keys, set `additionalProperties: true` explicitly or use `openObj(...)`.
- `@pluxel/cmd` re-exports TypeBox as `Type` (common) and `TypeBox` (full namespace).

This document is about **how to use** the API. For design rationale, see `packages/cmd/DESIGN.md`.

## Quick Start

```ts
import { Runtime } from '@sinclair/parsebox'
import { cmd, createRouter, obj, resolveMcpToolDef, textTail, Type } from '@pluxel/cmd'

const whereTail = textTail(
  new Runtime.Module({
    // parse the rest of the input as a raw string, then map into the *real* input fields
    Main: Runtime.Until(['\n'], (s) => ({ expr: s })),
  }),
  'Main',
)

const where = cmd('where')
  .input(obj({
    userId: Type.String(),
    force: Type.Optional(Type.Boolean()),
    expr: Type.String(),
  }))
  .text({ tail: whereTail })    // tail is text-only (keeps MCP schema clean)
  .doc({ description: 'Filter users (tail DSL supported)' })
  .mcp({ title: 'Where' })
  .handle((input) => input)
  .build()

// Optional: expose as an MCP tool (data-only meta).
// - `.mcp({ title })` defaults description from `doc.description` when omitted
// - `.mcp()` defaults title to `id` and description from `doc.description`
// const tool = resolveMcpToolDef(where.mcp!, { locale: 'zh-CN' })

// Optional safety: cap input length before tokenization (default: 16 KiB).
const router = createRouter({ caseInsensitive: true, maxTextLength: 16 * 1024 })
router.add(where)

await router.dispatch('where --user-id u1 --force x:"y z" and k=1')
// If tail contains `--...` / `-...`, use `--` sentinel:
await router.dispatch('where --user-id u1 -- x:"y z" and --literal -x')
```

## Examples

### Custom validation (server-only, aggregated)

JSON Schema can't express all constraints (cross-field checks, external lookups, tenancy rules, etc).
Use `validateInput()` / `validateOutput()` for extra checks; all issues are aggregated into a single validation error.

```ts
import { cmd, issue, obj, Type } from '@pluxel/cmd'

export const createUser = cmd('user.create')
  .input(obj({ email: Type.String({ format: 'email' }), tenantId: Type.String() }))
  .validateInput(
    async (i) => (i.tenantId === 'root' ? issue('tenantId is reserved', { path: ['tenantId'] }) : undefined),
    async (_i, ctx) => {
      // ctx can carry request-scoped services via ctx.meta (db, auth, etc)
      return undefined
    },
  )
  .handle(async () => ({ ok: true }))
  .build()
```

### 1) Flags only (aliases + short + quoting)

```ts
import { cmd, obj, Type } from '@pluxel/cmd'

export const ban = cmd('ban')
  .input(obj({
    userId: Type.String(),
    reason: Type.Optional(Type.String()),
    force: Type.Optional(Type.Boolean()),
  }))
  .text()
  .handle((i) => i)
  .build()
```

Accepted inputs:
- `ban --user-id u1 --reason "spam ads" --force`
- `ban --userId u1 -r=spam -f`
- `ban -u u1 --no-force`

### 2) Arrays (repeat, comma, JSON array)

```ts
export const label = cmd('label')
  .input(obj({
    ids: Type.Array(Type.Number()),
    tag: Type.String(),
  }))
  .text()
  .handle((i) => i)
  .build()
```

Accepted inputs:
- `label --ids 1 --ids 2 --ids 3 --tag hot`
- `label --ids 1,2,3 --tag hot`
- `label --ids [1,2,3] --tag hot`

### 3) JSON values

```ts
export const patch = cmd('patch')
  .input(obj({
    id: Type.String(),
    // Note: `json` params are object-typed (use a schema that maps to JSON Schema `{ type: "object" }`).
    data: Type.Record(Type.String(), Type.Unknown()),
  }))
  .text()
  .handle((i) => i)
  .build()
```

Accepted inputs:
- `patch --id 1 --data '{"a":1,"b":[2,3]}'`

### 4) Tail DSL (ParseBox) → patch real input fields

```ts
import { Runtime } from '@sinclair/parsebox'
import { cmd, obj, textTail, Type } from '@pluxel/cmd'

const whereTail = textTail(
  new Runtime.Module({
    // Minimal DSL example:
    // - extract `limit:<int>` into `limit`
    // - keep the rest as `expr`
    Main: Runtime.Until(['\n'], (s) => {
      const raw = s.trim()
      const m = /\blimit:(\d+)\b/.exec(raw)
      const limit = m ? Number(m[1]) : undefined
      const expr = m ? raw.replace(m[0], '').trim() : raw
      return { expr, ...(limit !== undefined ? { limit } : {}) }
    }),
  }),
  'Main',
)

export const where = cmd('where')
  .input(obj({
    userId: Type.String(),
    expr: Type.String(),
    limit: Type.Optional(Type.Number()),
  }))
  .text({ tail: whereTail })
  .handle((i) => i)
  .build()
```

Accepted inputs:
- `where --user-id u1 limit:10 status:open`  (tail → `{ limit: 10, expr: "status:open" }`)
- `where --user-id u1 -- limit:10 status:open --literal -x`

Notes:
- tail patch keys must exist in the schema (`expr/limit/...`)
- tail cannot override keyed params (e.g. `--limit 10 limit:20` is rejected)
- if tail contains tokens that look like known flags, use `--` to start tail explicitly

### 5) Short quality-of-life (bundling + attached values)

```ts
export const run = cmd('run')
  .input(obj({
    verbose: Type.Optional(Type.Boolean()),
    dryRun: Type.Optional(Type.Boolean()),
    jobs: Type.Optional(Type.Number()),
  }))
  .text()
  .handle((i) => i)
  .build()
```

Accepted inputs:
- `run -vd` (boolean bundling; if `-v/-d` are derived and unique)
- `run -j8` / `run -j=8` / `run --jobs 8`
- `run --no-verbose`

### 6) Router help (introspection data only)

```ts
import { createRouter } from '@pluxel/cmd'

const router = createRouter()
router.add(ban)

router.helpIndex()
router.helpCommand('ban')       // by id or trigger
```

### Type narrowing (Op ⇢ text / MCP)

`cmd().build()` always returns an `Op` (`Executable`). You can narrow it at runtime:

```ts
import { isMcpExecutable, isTextExecutable, resolveMcpToolDef } from '@pluxel/cmd'

if (isTextExecutable(ban)) {
  await ban.execText('ban --user-id u1')
}

if (isMcpExecutable(ban)) {
  // typed: ban.mcp.title / description / inputSchema / outputSchema?
  const tool = resolveMcpToolDef(ban.mcp, { locale: 'en-US' })
  tool.title
}
```

## Text Commands

### Enable text execution

```ts
cmd('echo').text()
cmd('echo').text({ triggers: ['e', 'say'] })
```

### Supported flag syntaxes (object input schema)

Derived from `input` JSON Schema (build-time):

- Long forms:
  - `--key value`
  - `--key=value`
  - `--no-key` (boolean only; aliases supported too)
- Inline assignments:
  - `key:value`
  - `key=value`
- Short forms (auto-derived; conflicts are dropped):
  - `-c value`
  - `-c=value`
  - `-cVALUE` (attached value; e.g. `-n10`, `-ufoo`, `-n-1`)
  - `-abc` (short bundling; **boolean-only**)
  - boolean short value is allowed: `-f false`

### Accepted long aliases (no config)

Each param has a canonical long name in **kebab-case**, and also accepts common variants:

- `--user-id` (canonical)
- `--userId` (camelCase)
- `--user_id` (snake_case)

This also applies to `--no-<alias>` and `key:value` / `key=value`.

### Arrays and JSON

- For `string[]/number[]/boolean[]`: repeatable flags append values:
  - `--tag a --tag b`
- For `string[]/number[]/boolean[]`: comma-separated values are supported:
  - `--tag a,b,c`
- For `json` / `json[]`: uses `JSON.parse(...)` (note: `json` is object-typed):
  - `--data {"a":1}`
  - `--items [{"a":1},{"a":2}]`

## ParseBox tail

### When to use

If you need “readable string DSL” after the flags (filters, expressions, routes, etc.),
provide a ParseBox parser via `text({ tail })`, and map it into your real input fields.

Notes:
- `@pluxel/cmd` appends a trailing `\\n` when invoking the ParseBox tail parser, so `Runtime.Until(['\\n'], ...)` works as “until end-of-line”.

### Tail start rules (no ambiguity)

When tail is enabled:
- `--` sentinel starts tail immediately: `cmd -- <tail...>`
- otherwise, tail starts at the first token that is **not** a known keyed argument
- in implicit mode, known keyed tokens are rejected inside tail; use `--` to force tail

## What is intentionally NOT supported

- Positionals for object schemas (no `echo <msg>` unless you enable tail and map it into real fields)
- Unknown flags are never ignored/collected (they error)
- `--` sentinel on commands without tail (errors)
- Unterminated quotes / dangling escapes in text (tokenization errors)
- Input schema key `_` (reserved)
- Mixed short bundling for non-boolean flags (e.g. `-abnX` is rejected)
- `-cVALUE` for boolean short flags (use `-c=false` or `-c false`)
- Case-insensitive long flags (long is exact; short is case-insensitive)
