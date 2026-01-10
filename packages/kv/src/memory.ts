import { Plugin } from '@pluxel/hmr'
import { TTLCache } from '@isaacs/ttlcache'
import { Kv, type KvDriver, type KvDriverSetOptions, type KvValue } from './core.js'

/**
 * In-memory KV provider.
 *
 * - TTL support via `@isaacs/ttlcache`
 * - Disables KV-layer coalescing (in-flight dedupe) to avoid overhead for local reads
 */
@Plugin(Kv, { name: 'Kv', type: 'service' })
export class KvMemory extends Kv {
	private cache = new TTLCache<string, KvValue>({
		ttl: Infinity,
		max: Infinity,
		checkAgeOnGet: true,
		checkAgeOnHas: true,
	})
	private kvDriver: KvDriver | undefined

	protected driver(): KvDriver {
		this.kvDriver ??= {
			/**
			 * This driver is entirely in-process and backed by a synchronous map-like cache.
			 *
			 * KV-level coalescing is mainly valuable for remote backends (network/IO) where
			 * multiple concurrent reads of the same key would otherwise create duplicated work.
			 *
			 * For memory, the "work" is already tiny, while coalescing would add extra overhead
			 * (Map bookkeeping + Promise allocation + invalidation keys). So we opt out here.
			 */
			coalesce: false,
			hasItem: async (key) => this.cache.has(key),
			getItem: async <T = unknown>(key: string) => (this.cache.get(key) as T | undefined) ?? null,
			setItem: async (key, value, options?: KvDriverSetOptions) => {
				const ttlSeconds = options?.ttl
				if (ttlSeconds === undefined) {
					this.cache.set(key, value)
					return
				}
				const ttlMs = Math.max(1, Math.ceil(Number(ttlSeconds) * 1000))
				this.cache.set(key, value, { ttl: ttlMs })
			},
			removeItem: async (key) => {
				this.cache.delete(key)
			},
			getKeys: async (base?: string) => {
				this.cache.purgeStale()
				const keys = [...this.cache.keys()]
				return base ? keys.filter((k) => k.startsWith(base)) : keys
			},
			clear: async (base?: string) => {
				this.cache.purgeStale()
				if (!base) {
					this.cache.clear()
					return
				}
				for (const key of this.cache.keys()) {
					if (key.startsWith(base)) this.cache.delete(key)
				}
			},
			dispose: async () => {
				;(this.cache as any).cancelTimer?.()
				this.cache.clear()
			},
		}
		return this.kvDriver
	}

	protected override async stop(_abort: AbortSignal): Promise<void> {
		;(this.cache as any).cancelTimer?.()
		this.cache.clear()
		this.kvDriver = undefined
		await super.stop(_abort)
	}
}
