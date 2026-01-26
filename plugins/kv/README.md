# pluxel-plugin-kv

KV service plugin + utilities.

## Install / Register

- Register the provider plugin (memory backend by default):
  - `import { plugins as kvPlugins } from 'pluxel-plugin-kv'`

## Use as a service (recommended)

Inject `Kv` and use caller-scoped APIs:

```ts
import { BasePlugin, Plugin } from '@pluxel/hmr'
import { Kv } from 'pluxel-plugin-kv'

@Plugin({ name: 'UserService' })
export class UserService extends BasePlugin {
  constructor(private kv: Kv) {
    super()
  }

  async getUser(id: string) {
    const scope = this.kv.scope()
    const key = `user:${id}`

    const cached = await scope.get(key)
    if (cached) return cached

    const fresh = { id }
    await scope.set(key, fresh, { ttlMs: 60_000 })
    return fresh
  }
}
```

## `kv.cached()` (TTL + SWR)

Use the built-in helper for TTL + optional stale-while-revalidate:

```ts
const user = await this.kv.cached({
  key: `user:${id}`,
  ttlMs: 60_000,
  staleTtlMs: 5 * 60_000,
  getFreshValue: () => fetchUser(id),
})
```

## `@Cached()` decorator

Cache method results using the injected `Kv` dependency:

```ts
import { BasePlugin, Plugin } from '@pluxel/hmr'
import { Kv, Cached } from 'pluxel-plugin-kv'

@Plugin({ name: 'Foo' })
export class Foo extends BasePlugin {
  constructor(private kv: Kv) {
    super()
  }

  @Cached({ ttlMs: 60_000 })
  async getUser(id: string) {
    return await fetchUser(id)
  }
}
```

## Rates (best-effort)

This package also ships a KV-backed `Rates` service for lightweight, best-effort limits.

```ts
import { BasePlugin, Plugin } from '@pluxel/hmr'
import { Rates } from 'pluxel-plugin-kv'

@Plugin({ name: 'Foo' })
export class Foo extends BasePlugin {
  constructor(private rates: Rates) {
    super()
  }

  async login(userId: string) {
    const r = await this.rates.cooldown(['login', userId], 10_000)
    if (!r.ok) return { ok: false, retryAfterMs: r.retryAfterMs }
    return { ok: true }
  }
}
```

Notes:
- This is not strictly distributed-safe (KV read-modify-write is not atomic across processes).
- Works without backend TTL, but TTL is used for cleanup when available.
- Limits are isolated by caller plugin id by default (built on KV scopes).
- There is no `slidingWindow` here by design; use `RedisRates.slidingWindow()` if you need that policy.

## RateGuard decorator (throws)

`@RateGuard(...)` runs the original method when allowed, and throws a `RateLimitError` when blocked.

```ts
import { BasePlugin, Plugin } from '@pluxel/hmr'
import { Rates, RateGuard, isRateLimitError } from 'pluxel-plugin-kv'

@Plugin({ name: 'Foo' })
export class Foo extends BasePlugin {
  constructor(private rates: Rates) { super() }

  @RateGuard({
    rule: { type: 'cooldown', ttlMs: 10_000 },
    parts: (_self, [userId]) => ['login', userId],
  })
  async login(userId: string) {
    // ...
  }
}

// Handling
try {
  await foo.login('u1')
} catch (e) {
  if (isRateLimitError(e)) {
    console.log(e.retryAfterMs, e.remaining)
  }
}
```

## Notes

- Keys are normalized: `/` and `\\` become `:`.
- `ttlMs` must be finite and > 0 (omit it for "no TTL").
- Values should be JSON-friendly (avoid circular objects) for cross-backend compatibility.
