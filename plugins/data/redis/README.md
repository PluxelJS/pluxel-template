# pluxel-plugin-redis

Redis client service plugin (ioredis).

## What you get

- `RedisPlugin`: a Redis client service that also provides the `Kv` token (Redis-backed KV).
- `redis.rates`: Redis-only Lua rate-limit primitives (scripts + NOSCRIPT reload).

## Register

```ts
import { plugins as redisPlugins } from 'pluxel-plugin-redis'
```

## Use Redis as KV

Inject `Kv` in consumers and register `RedisPlugin` as the provider.

```ts
import { BasePlugin, Plugin } from '@pluxel/hmr'
import { Kv } from 'pluxel-plugin-kv'

@Plugin({ name: 'Foo' })
export class Foo extends BasePlugin {
  constructor(private kv: Kv) {
    super()
  }

  async ping() {
    await this.kv.set('demo', { ok: true }, { ttlMs: 10_000 })
    return await this.kv.get('demo')
  }
}
```

## Use low-level Redis session

```ts
import { BasePlugin, Plugin } from '@pluxel/hmr'
import { RedisPlugin } from 'pluxel-plugin-redis'

@Plugin({ name: 'Scripts' })
export class Scripts extends BasePlugin {
  constructor(private redis: RedisPlugin) {
    super()
  }

  async init() {
    await this.redis.use(async (c) => {
      const sha = await c.scriptLoad('return 1')
      await c.evalSha<number>(sha)
    })
  }
}
```

## Redis-optimized rates

```ts
import { BasePlugin, Plugin } from '@pluxel/hmr'
import { RedisPlugin } from 'pluxel-plugin-redis'

@Plugin({ name: 'Foo' })
export class Foo extends BasePlugin {
  constructor(private redis: RedisPlugin) { super() }

  async login(userId: string) {
    const r = await this.redis.rates.cooldown(['login', userId], 10_000)
    if (!r.ok) return { ok: false, retryAfterMs: r.retryAfterMs }
    return { ok: true }
  }
}
```

Notes:
- Keys are isolated by caller plugin id by default (so different plugins don't collide).
- Pass an explicit `scopeKey` (last argument) if you want to share limits across plugins.
- `fixedWindow()` on Redis returns `{ ok:false, retryAfterMs }` (computed via `PTTL` in Lua).

## RateGuard decorator (throws)

`pluxel-plugin-redis` also exports a `RateGuard(...)` decorator that uses `redis.rates` (supports `sliding`).
It runs the original method when allowed, and throws a `RateLimitError` when blocked.

```ts
import { BasePlugin, Plugin } from '@pluxel/hmr'
import { RateGuard } from 'pluxel-plugin-redis'
import { isRateLimitError } from 'pluxel-plugin-kv'

@Plugin({ name: 'Foo' })
export class Foo extends BasePlugin {
  @RateGuard({
    rule: { type: 'sliding', windowMs: 10_000, limit: 5 },
    parts: (_self, [userId]) => ['login', userId],
  })
  async login(userId: string) {
    return { ok: true }
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
