import type { KvSetOptions, KvValue } from './types.js'

export type KvCacheStore = {
	/** Read cached value (raw). */
	get: <T = unknown>(key: string) => Promise<T | null>
	/** Write cached value (raw). */
	set: <T extends KvValue = KvValue>(key: string, value: T, options?: KvSetOptions) => Promise<void>
	/** Optional delete primitive (used for `isCacheable=false`). */
	del?: (key: string) => Promise<void>
} & object

export type KvCachedOptions<T> = {
	/**
	 * Cache store (usually `kv.scope()` or an injected `Kv` service).
	 * Kept deliberately tiny to avoid abstraction overhead.
	 */
	store: KvCacheStore
	/** Cache key (you decide namespacing, e.g. `cache:user:${id}`) */
	key: string
	/** Fresh TTL in milliseconds (must be finite and > 0). */
	ttlMs: number
	/**
	 * Keep stale entries for this long (ms) to enable "stale-while-revalidate".
	 * If not provided (or <= ttlMs), SWR is disabled and cache behaves like a simple TTL cache.
	 */
	staleTtlMs?: number
	/** Compute a fresh value when cache is missing/stale. */
	getFreshValue: () => Promise<T>

	/**
	 * In-process de-duplication of concurrent refreshes for the same key.
	 * This is separate from KV-driver coalescing:
	 * - KV coalescing de-dupes *backend calls* (e.g. Redis GET).
	 * - This de-dupes the *fresh computation* (`getFreshValue`) to prevent stampedes on misses.
	 */
	dedupe?: boolean

	/**
	 * If SWR is enabled, return stale immediately and refresh in background.
	 * Default: true (when SWR is enabled).
	 */
	swr?: boolean

	/**
	 * When refresh fails and there is a stale value available, return stale instead of throwing.
	 * Default: true.
	 */
	fallbackToStaleOnError?: boolean

	/**
	 * Customize serialization when your value isn't naturally JSON-friendly.
	 * Default: store as-is (must be compatible with the underlying KV backend).
	 */
	serialize?: (value: T) => KvValue
	deserialize?: (raw: unknown) => T

	/** Decide whether a value should be cached (e.g. skip caching null/empty). */
	isCacheable?: (value: T) => boolean

	/** Error hook for background refresh. */
	onRefreshError?: (error: unknown) => void

	/** Time source (mainly for tests). */
	now?: () => number
}

type CacheEnvelope = {
	v: KvValue
	f: number
	s?: number
}

const noop = () => {}
const inflightByStore = new WeakMap<object, Map<string, Promise<any>>>()

function inflightFor(store: object): Map<string, Promise<any>> {
	let map = inflightByStore.get(store)
	if (!map) {
		map = new Map()
		inflightByStore.set(store, map)
	}
	return map
}

function isEnvelope(x: unknown): x is CacheEnvelope {
	if (!x || typeof x !== 'object') return false
	const any = x as any
	return typeof any.f === 'number' && 'v' in any
}

async function coalesce<T>(store: object, key: string, run: () => Promise<T>): Promise<T> {
	const inflight = inflightFor(store)
	const existing = inflight.get(key) as Promise<T> | undefined
	if (existing) return existing
	const promise = (async () => await run())()
	inflight.set(key, promise)
	promise.finally(() => {
		if (inflight.get(key) === promise) inflight.delete(key)
	})
	return promise
}

/**
 * A small, dependency-free caching helper inspired by "cachified" patterns:
 * - TTL cache with optional stale-while-revalidate
 * - per-process stampede protection (dedupe) for cache misses
 *
 * It intentionally avoids extra layers (no adapters, no classes): you pass a tiny `store`
 * and the function stores a compact envelope `{ v, f, s }` under `key`.
 *
 * Typical usage inside a plugin (recommended: caller-scope via `kv.cached()`):
 *
 * ```ts
 * const value = await kvCached({
 *   store: kv.scope(),
 *   key: `user:${id}`,
 *   ttlMs: 60_000,
 *   staleTtlMs: 5 * 60_000, // optional SWR window
 *   getFreshValue: () => fetchUser(id),
 * })
 * ```
 */
export async function kvCached<T>(options: KvCachedOptions<T>): Promise<T> {
	const {
		store,
		key,
		ttlMs,
		staleTtlMs,
			getFreshValue,
			dedupe = true,
			swr,
			fallbackToStaleOnError = true,
			serialize = (v) => v as any as KvValue,
			deserialize = (raw) => raw as T,
			isCacheable = () => true,
			onRefreshError,
			now = Date.now,
		} = options

	if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
		throw new Error('[Kv] kvCached() requires ttlMs to be a positive, finite number')
	}
	if (staleTtlMs !== undefined && !Number.isFinite(staleTtlMs)) {
		throw new Error('[Kv] kvCached() requires staleTtlMs to be finite when provided')
	}

	const swrWindowMs = staleTtlMs !== undefined && staleTtlMs > ttlMs ? staleTtlMs : undefined
	const swrEnabled = swrWindowMs !== undefined && (swr ?? true)
	const swallowRefreshError = onRefreshError ?? noop

	const cached = await store.get<unknown>(key)
	const envelope = isEnvelope(cached) ? cached : null

	const n = now()
	if (envelope && n < envelope.f) {
		return deserialize(envelope.v)
	}

	if (envelope && swrEnabled && envelope.s !== undefined && n < envelope.s) {
		const refresh = async () => await computeAndStore()
		if (dedupe) {
			coalesce(store, `refresh:${key}`, refresh).catch(swallowRefreshError)
		} else {
			refresh().catch(swallowRefreshError)
		}
		return deserialize(envelope.v)
	}

	const compute = async () => await computeAndStore(envelope)
	return dedupe
		? await coalesce(store, `refresh:${key}`, compute)
		: await compute()

	async function computeAndStore(existing?: CacheEnvelope | null): Promise<T> {
		try {
			const value = await getFreshValue()
			if (!isCacheable(value)) {
				if (store.del) await store.del(key)
				return value
			}

			const t = now()
			const f = t + ttlMs
			const s = swrWindowMs ? t + swrWindowMs : undefined
			const keepTtlMs = swrWindowMs ?? ttlMs

			const next: CacheEnvelope = { v: serialize(value), f, ...(s ? { s } : {}) }
			await store.set(key, next, { ttlMs: keepTtlMs })
			return value
		} catch (error) {
			if (fallbackToStaleOnError && existing && existing.v !== undefined) {
				return deserialize(existing.v)
			}
			throw error
		}
	}
}
