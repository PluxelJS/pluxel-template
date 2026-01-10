import { BasePlugin } from '@pluxel/hmr'

export type KvScopeKey = string
export type KvValue = null | string | number | boolean | object

export type KvSetOptions = {
	/**
	 * TTL in milliseconds.
	 * Note: this is best-effort; actual resolution depends on backend driver.
	 */
	ttlMs?: number
}

export type KvDriverSetOptions = {
	/** TTL in seconds. */
	ttl?: number
}

export interface KvDriver {
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

	get: <T = unknown>(key: string) => Promise<T | null>
	set: <T extends KvValue = KvValue>(key: string, value: T, options?: KvSetOptions) => Promise<void>
	del: (key: string) => Promise<void>
	has: (key: string) => Promise<boolean>
	keys: () => Promise<string[]>
	clear: () => Promise<void>
}

export abstract class Kv extends BasePlugin {
	/** Backend driver. */
	protected abstract driver(): KvDriver

	protected requireCallerScopeKey(method: string): KvScopeKey {
		const callerId = this.ctx.caller?.pluginInfo?.id
		if (!callerId) {
			throw new Error(`[Kv] ${method}() requires caller context (call it inside a plugin)`)
		}
		return callerId
	}

	/**
	 * Get a scoped view:
	 * - `scope()` uses caller plugin id (recommended).
	 * - `scope('X')` uses explicit scope (scripts/tests/shared namespace).
	 */
	scope(scopeKey?: KvScopeKey): KvScope {
		const key = scopeKey ?? this.requireCallerScopeKey('scope')
		const base = normalizeKey(key)
		if (!base) {
			throw new Error('[Kv] invalid scopeKey (empty after normalization)')
		}
		const prefix = normalizeBaseKey(base)
		const driver = this.driver()

		const withPrefix = (raw: string) => `${prefix}${normalizeKey(raw)}`
		const requireKey = (raw: string) => {
			const k = normalizeKey(raw)
			if (!k) throw new Error('[Kv] invalid key (empty after normalization)')
			return `${prefix}${k}`
		}

		return {
			key,
			prefix,
			get: async <T = unknown>(k: string) => (await driver.getItem(requireKey(k))) as T | null,
			set: async <T extends KvValue = KvValue>(k: string, value: T, options?: KvSetOptions) => {
				const ttlMs = options?.ttlMs
				if (ttlMs === undefined) {
					await driver.setItem(requireKey(k), value)
					return
				}
				const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000))
				await driver.setItem(requireKey(k), value, { ttl: ttlSeconds })
			},
			del: async (k: string) => {
				await driver.removeItem(requireKey(k))
			},
			has: async (k: string) => {
				return await driver.hasItem(requireKey(k))
			},
			keys: async () => {
				const keys = await driver.getKeys(prefix)
				return keys
					.filter((k) => k.startsWith(prefix) && !k.endsWith('$'))
					.map((k) => k.slice(prefix.length))
			},
			clear: async () => {
				await driver.clear(prefix)
			},
		}
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
