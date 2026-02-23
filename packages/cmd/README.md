# @pluxel/cmd

Schema-first command/op runtime:
- `input/output` validation via **TypeBox (JSON Schema)** (with TypeBox `default` injection)
- text commands via a single **schema-derived flag parser**
- optional tail parsing:
  - `tailTo`: map “the rest of the text” into a single input field (zero dependency)
  - `tail` (ParseBox): parse “the rest of the text” as a DSL and merge an **object patch** (text-only)

Notes:
- Object schemas are treated as **strict** by default when `additionalProperties` is omitted (including nested objects). To allow unknown keys, set `additionalProperties: true` explicitly or use `openObj(...)`.
- TypeBox is re-exported as `Type` (common) and `TypeBox` (full namespace).

This README documents the **public, canonical** API. Design rationale: `./DESIGN.md`.

## Canonical API: `Cmd.createSpace()`

The only recommended way to define + install commands is:
- `Cmd.createSpace()` to create a shared command space (router + registry)
- `space.scope(scopeKey)` to create a scope-scoped installer (plugins/products)

```ts
import { Cmd } from '@pluxel/cmd'

type Ctx = { now: number }

const space = Cmd.createSpace<Ctx>({ caseInsensitive: true })
const kit = space.scope('demo')

kit.install(
  kit.group(
    'meme',
    kit.command('list', { title: 'List', description: 'List memes' })
      .input({ query: kit.Type.Optional(kit.Type.String()) })
      .tail(kit.tail.line('query'))
      .handle(({ input, ctx }) => `${String(input.query ?? '')} @ ${ctx.now}`),
  ),
)

await space.dispatch('meme list --query hi', { now: Date.now() })
```

## Notes

- MCP-first defaults: non-`internal` commands/ops expose MCP tools by default; disable with `.mcp(false)`.
- Downstream/product policies (permissions/rates/tracing) should be implemented via `space.scope(scopeKey, { decorate })`,
  and metadata should be carried via `spec.ext` (`.ext({...})`) during installation.
