/**
 * Scope key used to namespace storage.
 *
 * In normal usage you don't set this manually; call `kv.scope()` and it will default
 * to the caller plugin id (`ctx.caller.pluginInfo.id`).
 */
export type KvScopeKey = string

/**
 * Values supported by KV.
 *
 * Notes:
 * - Keep values JSON-friendly; some backends (Redis) store via JSON serialization.
 * - Avoid circular objects.
 */
export type KvValue = null | string | number | boolean | object

export type KvSetOptions = {
	/**
	 * TTL in milliseconds.
	 * Note: this is best-effort; actual resolution depends on backend driver.
	 *
	 * Omit for "no TTL".
	 */
	ttlMs?: number
}

export type KvDriverSetOptions = {
	/** TTL in seconds. */
	ttl?: number
}
