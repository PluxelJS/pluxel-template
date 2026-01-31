import { BasePlugin } from '@pluxel/hmr'
import { kvCached, type KvCachedOptions } from './cache.js'
import type { KvDriverSetOptions, KvScopeKey, KvSetOptions, KvValue } from './types.js'
import { getKvRates, KV_RATES, type KvRates, type RatesApi } from './kv_rates.js'

export type { KvDriverSetOptions, KvScopeKey, KvSetOptions, KvValue } from './types.js'

export interface KvDriver {
	/**
	 * Disable KV-layer in-flight coalescing (default enabled).
	 *
	 * Coalescing is primarily an optimization for *remote / async* backends (e.g. Redis):
	 * it prevents a "thundering herd" where many concurrent reads of the same key fan out
	 * into multiple network round-trips.
	 *
	 * For ultra-cheap local backends (in-memory), the bookkeeping cost (Map lookups +
	 * Promise allocation + invalidation bookkeeping) can be comparable to, or higher than,
	 * just doing the operation again, so those drivers can opt out.
	 */
	coalesce?: boolean
	hasItem: (key: string) => Promise<boolean>
	getItem: <T = unknown>(key: string) => Promise<T | null>
	setItem: (key: string, value: KvValue, options?: KvDriverSetOptions) => Promise<void>
	removeItem: (key: string) => Promise<void>
	getKeys: (base?: string) => Promise<string[]>
	clear: (base?: string) => Promise<void>
	dispose?: () => Promise<void>
}

export interface KvScope {
	key: KvScopeKey
	prefix: string

	/**
	 * Get a value by key (within this scope).
	 *
	 * Keys are normalized (slashes become `:`), so `user/1` and `user:1` map to the same entry.
	 */
	get: <T = unknown>(key: string) => Promise<T | null>
	/**
	 * Set a value by key (within this scope).
	 *
	 * `ttlMs` is best-effort and backend dependent; Redis uses second granularity.
	 */
	set: <T extends KvValue = KvValue>(key: string, value: T, options?: KvSetOptions) => Promise<void>
	/** Delete a key (within this scope). */
	del: (key: string) => Promise<void>
	/** Check existence (within this scope). */
	has: (key: string) => Promise<boolean>
	/** List keys (within this scope). */
	keys: () => Promise<string[]>
	/** Clear all keys (within this scope). */
	clear: () => Promise<void>
}

/**
 * KV service token + base implementation.
 *
 * Key ideas:
 * - Scoped by *caller plugin id* by default (`kv.scope()` / `kv.get()` / `kv.set()`), so plugins don't collide.
 * - Backend-agnostic via `KvDriver` (memory, redis, ...).
 * - Optional in-flight coalescing for remote backends to reduce duplicate concurrent IO.
 */
export abstract class Kv extends BasePlugin {
	/** Backend driver. */
	protected abstract driver(): KvDriver

	/** Best-effort rates helper (caller-scoped by default). */
	get rates(): RatesApi {
		return getKvRates(this)
	}

	/**
	 * In-flight de-duplication of *identical* operations.
	 *
	 * Note:
	 * - This does not make things "sync": callers still `await` Promises.
	 * - It only helps when there are *concurrent* operations for the same cache-key.
	 */
	private inflight = new Map<string, Promise<any>>()
	private scopes = new Map<string, KvScope>()

	protected requireCallerScopeKey(method: string): KvScopeKey {
		const callerId = this.ctx.caller?.pluginInfo?.id
		if (!callerId) {
			throw new Error(`[Kv] ${method}() requires caller context (call it inside a plugin)`)
		}
		return callerId
	}

	private coalesce<T>(key: string, run: () => Promise<T>): Promise<T> {
		const existing = this.inflight.get(key) as Promise<T> | undefined
		if (existing) return existing
		const promise = (async () => await run())()
		this.inflight.set(key, promise)
		promise.finally(() => {
			// Only delete if still pointing to the same promise.
			if (this.inflight.get(key) === promise) this.inflight.delete(key)
		})
		return promise
	}

	private invalidate(prefix: string, key?: string): void {
		// invalidate prefix-level ops
		this.inflight.delete(`keys:${prefix}`)

		if (!key) return
		this.inflight.delete(`get:${prefix}${key}`)
		this.inflight.delete(`has:${prefix}${key}`)
	}

	/**
	 * Get a scoped view:
	 * - `scope()` uses caller plugin id (recommended).
	 * - `scope('X')` uses explicit scope (scripts/tests/shared namespace).
	 */
	scope(scopeKey?: KvScopeKey): KvScope {
		const raw = scopeKey ?? this.requireCallerScopeKey('scope')
		const base = normalizeKey(raw)
		if (!base) {
			throw new Error('[Kv] invalid scopeKey (empty after normalization)')
		}

		const existing = this.scopes.get(base)
		if (existing) return existing

		const prefix = normalizeBaseKey(base)
		const driver = this.driver()
		const enableCoalesce = driver.coalesce !== false

		const coalesce = <T>(ckey: string, run: () => Promise<T>) =>
			enableCoalesce ? this.coalesce(ckey, run) : run()

		const requireKey = (raw: string) => {
			const k = normalizeKey(raw)
			if (!k) throw new Error('[Kv] invalid key (empty after normalization)')
			return `${prefix}${k}`
		}

		const scope: KvScope = {
			key: base,
			prefix,
			get: async <T = unknown>(k: string) => {
				const full = requireKey(k)
				return await coalesce(`get:${full}`, async () => (await driver.getItem(full)) as T | null)
			},
			set: async <T extends KvValue = KvValue>(k: string, value: T, options?: KvSetOptions) => {
				const full = requireKey(k)
				this.invalidate(prefix, normalizeKey(k))

				const ttlMs = options?.ttlMs
				if (ttlMs === undefined) {
					await driver.setItem(full, value)
					return
				}
				if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
					throw new Error('[Kv] ttlMs must be a positive, finite number (omit it for no TTL)')
				}
				const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000))
				await driver.setItem(full, value, { ttl: ttlSeconds })
			},
			del: async (k: string) => {
				const full = requireKey(k)
				this.invalidate(prefix, normalizeKey(k))
				await driver.removeItem(full)
			},
			has: async (k: string) => {
				const full = requireKey(k)
				return await coalesce(`has:${full}`, async () => await driver.hasItem(full))
			},
			keys: async () => {
				const keys = await coalesce(`keys:${prefix}`, async () => await driver.getKeys(prefix))
				return keys
					.filter((k) => k.startsWith(prefix) && !k.endsWith('$'))
					.map((k) => k.slice(prefix.length))
			},
			clear: async () => {
				this.invalidate(prefix)
				await driver.clear(prefix)
			},
		}

		this.scopes.set(base, scope)
		return scope
	}

	/**
	 * High-level cache helper (TTL + optional SWR + stampede protection).
	 *
	 * Convenience wrapper around `kvCached()` that defaults to caller scope:
	 *
	 * ```ts
	 * const user = await kv.cached({
	 *   key: `user:${id}`,
	 *   ttlMs: 60_000,
	 *   getFreshValue: () => fetchUser(id),
	 * })
	 * ```
	 */
	cached<T>(options: Omit<KvCachedOptions<T>, 'store'> & { scopeKey?: KvScopeKey }): Promise<T> {
		const { scopeKey, ...rest } = options
		return kvCached<T>({ store: this.scope(scopeKey), ...rest })
	}

	/** Caller-scope shortcut. */
	get<T = unknown>(key: string): Promise<T | null> {
		return this.scope().get<T>(key)
	}
	/** Caller-scope shortcut. */
	set<T extends KvValue = KvValue>(key: string, value: T, options?: KvSetOptions): Promise<void> {
		return this.scope().set<T>(key, value, options)
	}
	/** Caller-scope shortcut. */
	del(key: string): Promise<void> {
		return this.scope().del(key)
	}
	/** Caller-scope shortcut. */
	has(key: string): Promise<boolean> {
		return this.scope().has(key)
	}
	/** Caller-scope shortcut. */
	keys(): Promise<string[]> {
		return this.scope().keys()
	}
	/** Caller-scope shortcut. */
	clear(): Promise<void> {
		return this.scope().clear()
	}

	protected override async stop(_abort: AbortSignal): Promise<void> {
		const rates = (this as unknown as Record<symbol, unknown>)[KV_RATES] as KvRates | undefined
		rates?.dispose()
		this.inflight.clear()
		this.scopes.clear()
	}
}

function normalizeKey(key: string): string {
	if (!key) return ''
	return (
		key
			.split('?')[0]
			?.replace(/[/\\]/g, ':')
			.replace(/:+/g, ':')
			.replace(/^:|:$/g, '') || ''
	)
}

function normalizeBaseKey(base: string): string {
	const key = normalizeKey(base)
	return key ? `${key}:` : ''
}
