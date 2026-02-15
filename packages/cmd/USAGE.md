# @pluxel/cmd — Usage

`@pluxel/cmd` is a schema-first command runtime:
- `input/output` validation via **Standard Schema v1**
- text commands via a **single schema-derived flag parser**
- optional ParseBox-powered tail DSL (text-only patch)

This document is about **how to use** the API. For design rationale, see `packages/cmd/DESIGN.md`.

## Quick Start

```ts
import * as v from 'valibot'
import { Runtime } from '@sinclair/parsebox'
import { cmd, createRouter, textTail } from '@pluxel/cmd'

const whereTail = textTail(
  new Runtime.Module({
    // parse the rest of the input as a raw string, then map into the *real* input fields
    Main: Runtime.Until(['\n'], (s) => ({ expr: s })),
  }),
  'Main',
)

const where = cmd('where')
  .input(v.object({
    userId: v.string(),
    force: v.optional(v.boolean()),
    expr: v.string(),
  }))
  .text({ tail: whereTail })    // tail is text-only (keeps MCP schema clean)
  .handle((input) => input)
  .build()

const router = createRouter({ caseInsensitive: true })
router.add(where)

await router.dispatch('where --user-id u1 --force x:"y z" and k=1')
// If tail contains `--...` / `-...`, use `--` sentinel:
await router.dispatch('where --user-id u1 -- x:"y z" and --literal -x')
```

## Examples

### 1) Flags only (aliases + short + quoting)

```ts
import * as v from 'valibot'
import { cmd } from '@pluxel/cmd'

export const ban = cmd('ban')
  .input(v.object({
    userId: v.string(),
    reason: v.optional(v.string()),
    force: v.optional(v.boolean()),
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
  .input(v.object({
    ids: v.array(v.number()),
    tag: v.string(),
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
  .input(v.object({
    id: v.string(),
    // Note: `json` params are object-typed (use a schema that maps to JSON Schema `{ type: "object" }`).
    data: v.record(v.string(), v.unknown()),
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
import { textTail } from '@pluxel/cmd'

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
  .input(v.object({
    userId: v.string(),
    expr: v.string(),
    limit: v.optional(v.number()),
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
  .input(v.object({
    verbose: v.optional(v.boolean()),
    dryRun: v.optional(v.boolean()),
    jobs: v.optional(v.number()),
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
- cmdkit appends a trailing `\\n` when invoking the ParseBox tail parser, so `Runtime.Until(['\\n'], ...)` works as “until end-of-line”.

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
