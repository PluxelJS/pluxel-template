import { pluginMethodDecorator } from '@pluxel/hmr'
import type { KvCachedOptions } from './cache.js'
import { Kv } from './core.js'

type AnyFn = (...args: any[]) => any

export type CachedKeyFn<Self, Args extends any[]> = (self: Self, args: Args, method: string) => string

export type CachedOptions<Self, Args extends any[], T> = Partial<
	Omit<KvCachedOptions<T>, 'store' | 'key' | 'getFreshValue'>
> & {
	/**
	 * TTL in milliseconds.
	 *
	 * If omitted, `@Cached()` behaves like a simple memoize:
	 * - key = `<method>:<args>`
	 * - no envelope/stale/SWR; value is stored as-is in KV
	 * - all other `kvCached`-related options are ignored
	 */
	ttlMs?: number

	/**
	 * Optional key builder.
	 *
	 * Default: `<method>:<JSON.stringify(args)>` (with a safe fallback for circular args).
	 *
	 * Note:
	 * When used with `Kv` (caller-scoped), different plugins do not collide even with the same key,
	 * because the underlying KV scope is derived from `ctx.caller.pluginInfo.id`.
	 */
	key?: CachedKeyFn<Self, Args>
}

function safeArgsKey(args: any[]): string {
	if (args.length === 0) return '[]'
	try {
		return JSON.stringify(args)
	} catch {
		// Best-effort fallback for circulars; keep it cheap.
		return args.map((a) => (typeof a === 'string' ? a : String(a))).join('|')
	}
}

/**
 * Method decorator: cache method result in the injected `Kv` service.
 *
 * Design goals:
 * - No `self.kv` naming assumption: dependency is resolved by DI token (`Kv`).
 * - Ensures ctor deps are declared: relies on `pluginMethodDecorator(Kv, ...)`.
 * - Fast path when `ttlMs` is not set (simple memoize).
 * - Optional TTL/SWR features via `kv.cached()` when `ttlMs` is set.
 *
 * Usage:
 * ```ts
 * class Foo extends BasePlugin {
 *   constructor(private kv: Kv) { super() }
 *
 *   @Cached({ ttlMs: 60_000 })
 *   async getUser(id: string) {
 *     return await fetchUser(id)
 *   }
 * }
 * ```
 */
export function Cached<Self, Args extends any[], T>(options: CachedOptions<Self, Args, T> = {}): MethodDecorator {
	return pluginMethodDecorator(Kv, async function (original: AnyFn, kv: Kv, key, ...args: any[]) {
		const method = String(key)
		const cacheKey =
			options.key?.(this as any, args as any, method) ?? `${method}:${safeArgsKey(args)}`

		// Fast path: memoize with plain values (no envelope, no TTL).
		if (options.ttlMs === undefined) {
			if (await kv.has(cacheKey)) return await kv.get(cacheKey)
			const value = await original.apply(this, args)
			await kv.set(cacheKey, value)
			return value
		}

		// Advanced path: TTL/SWR/stampede protection via kv.cached() envelope.
		return await kv.cached<T>({
			key: cacheKey,
			ttlMs: options.ttlMs,
			staleTtlMs: options.staleTtlMs,
			dedupe: options.dedupe,
			swr: options.swr,
			fallbackToStaleOnError: options.fallbackToStaleOnError,
			serialize: options.serialize,
			deserialize: options.deserialize,
			isCacheable: options.isCacheable,
			onRefreshError: options.onRefreshError,
			now: options.now,
			getFreshValue: async () => await original.apply(this, args),
		})
	})
}
