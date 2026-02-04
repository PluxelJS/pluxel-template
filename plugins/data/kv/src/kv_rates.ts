import type { KvScopeKey } from './types.js'
import type { KvScope } from './core.js'
import type { KvRateRule, RateDecision, RateParts, RateRule } from './rates_types.js'

export const KV_RATES = Symbol.for('pluxel:kv:rates')

export type KvRatesHost = {
	scope: (scopeKey?: KvScopeKey) => KvScope
}

export interface RatesApi {
	cooldown: (parts: RateParts, ttlMs: number, scopeKey?: KvScopeKey) => Promise<RateDecision>
	fixedWindow: (
		parts: RateParts,
		periodMs: number,
		limit: number,
		scopeKey?: KvScopeKey,
	) => Promise<RateDecision>
	tokenBucket: (
		parts: RateParts,
		cap: number,
		refillPerSec: number,
		cost?: number,
		scopeKey?: KvScopeKey,
	) => Promise<RateDecision>
	guard: (
		opts:
			| { type: 'cooldown'; parts: RateParts; ttlMs: number }
			| { type: 'fixed'; parts: RateParts; periodMs: number; limit: number }
			| { type: 'token'; parts: RateParts; cap: number; refillPerSec: number; cost?: number },
		scopeKey?: KvScopeKey,
	) => Promise<RateDecision>
}

type CooldownState = { exp: number }
type FixedWindowState = { count: number; resetAt: number }
type TokenBucketState = { tokens: number; ts: number }

export class KvRates implements RatesApi {
	/**
	 * In-flight de-duplication of *identical* operations.
	 *
	 * Note:
	 * - This does not make things "sync": callers still `await` Promises.
	 * - It only helps when there are *concurrent* operations for the same cache-key.
	 */
	private inflight = new Map<string, Promise<unknown>>()

	constructor(private readonly host: KvRatesHost) {}

	dispose(): void {
		this.inflight.clear()
	}

	private coalesce<T>(key: string, run: () => Promise<T>): Promise<T> {
		const existing = this.inflight.get(key) as Promise<T> | undefined
		if (existing) return existing
		const promise = (async () => await run())()
		this.inflight.set(key, promise)
		promise.finally(() => {
			if (this.inflight.get(key) === promise) this.inflight.delete(key)
		})
		return promise
	}

	private key(kind: string, parts: Array<string | number>): string {
		return `rates:${kind}:${parts.join(':')}`
	}

	private scope(scopeKey?: KvScopeKey) {
		return this.host.scope(scopeKey)
	}

	/** Cooldown: ok -> `{ok:true}`; blocked -> `{ok:false,retryAfterMs}` */
	async cooldown(parts: RateParts, ttlMs: number, scopeKey?: KvScopeKey): Promise<RateDecision> {
		if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
			throw new Error('[rates] cooldown ttlMs must be a positive, finite number')
		}
		const scope = this.scope(scopeKey)
		const k = this.key('cool', parts)
		return await this.coalesce(`cool:${scope.prefix}${k}`, async () => {
			const n = Date.now()
			const state = await scope.get<CooldownState>(k)
			if (state && typeof state.exp === 'number' && state.exp > n) {
				return { ok: false, retryAfterMs: Math.max(0, state.exp - n) }
			}
			const exp = n + ttlMs
			await scope.set(k, { exp }, { ttlMs })
			return { ok: true }
		})
	}

	/** Fixed window (ms): remaining >= 0 ok; else blocked with retryAfterMs. */
	async fixedWindow(
		parts: RateParts,
		periodMs: number,
		limit: number,
		scopeKey?: KvScopeKey,
	): Promise<RateDecision> {
		if (!Number.isFinite(periodMs) || periodMs <= 0) {
			throw new Error('[rates] fixedWindow periodMs must be a positive, finite number')
		}
		if (!Number.isFinite(limit) || limit <= 0) {
			throw new Error('[rates] fixedWindow limit must be a positive, finite number')
		}
		const scope = this.scope(scopeKey)
		const k = this.key('fixed', parts)
		return await this.coalesce(`fixed:${scope.prefix}${k}`, async () => {
			const n = Date.now()
			const prev = await scope.get<FixedWindowState>(k)

			let resetAt = n + periodMs
			let count = 0

			if (prev && typeof prev.resetAt === 'number' && prev.resetAt > n) {
				resetAt = prev.resetAt
				count = typeof prev.count === 'number' ? prev.count : 0
			}

			count += 1
			const remaining = limit - count
			const retryAfterMs = Math.max(0, resetAt - n)

			await scope.set(k, { count, resetAt }, { ttlMs: retryAfterMs + 1000 })
			return remaining >= 0 ? { ok: true, remaining } : { ok: false, retryAfterMs, remaining }
		})
	}

	/** Token bucket: remaining >= 0 ok; else blocked with retryAfterMs. */
	async tokenBucket(
		parts: RateParts,
		cap: number,
		refillPerSec: number,
		cost = 1,
		scopeKey?: KvScopeKey,
	): Promise<RateDecision> {
		if (!Number.isFinite(cap) || cap <= 0) throw new Error('[rates] tokenBucket cap must be > 0')
		if (!Number.isFinite(refillPerSec) || refillPerSec <= 0) {
			throw new Error('[rates] tokenBucket refillPerSec must be > 0')
		}
		if (!Number.isFinite(cost) || cost <= 0) throw new Error('[rates] tokenBucket cost must be > 0')

		const scope = this.scope(scopeKey)
		const k = this.key('token', parts)
		return await this.coalesce(`token:${scope.prefix}${k}`, async () => {
			const n = Date.now()
			const prev = await scope.get<TokenBucketState>(k)

			let tokens = cap
			let ts = n
			if (prev && typeof prev.ts === 'number') {
				ts = prev.ts
				tokens = typeof prev.tokens === 'number' ? prev.tokens : cap
			}

			if (n > ts) {
				const add = ((n - ts) * refillPerSec) / 1000
				tokens = Math.min(cap, tokens + add)
				ts = n
			}

			const ttlMs = Math.max(1000, Math.ceil((cap / refillPerSec) * 1000))
			if (tokens >= cost) {
				tokens -= cost
				await scope.set(k, { tokens, ts }, { ttlMs })
				return { ok: true, remaining: Math.floor(tokens) }
			}

			const need = cost - tokens
			const waitMs = Math.max(0, Math.ceil((need / refillPerSec) * 1000))
			await scope.set(k, { tokens, ts }, { ttlMs })
			return { ok: false, retryAfterMs: waitMs, remaining: Math.floor(tokens) }
		})
	}

	/** Unified entrypoint. */
	async guard(
		opts:
			| { type: 'cooldown'; parts: RateParts; ttlMs: number }
			| { type: 'fixed'; parts: RateParts; periodMs: number; limit: number }
			| { type: 'token'; parts: RateParts; cap: number; refillPerSec: number; cost?: number },
		scopeKey?: KvScopeKey,
	): Promise<RateDecision> {
		switch (opts.type) {
			case 'cooldown':
				return await this.cooldown(opts.parts, opts.ttlMs, scopeKey)
			case 'fixed':
				return await this.fixedWindow(opts.parts, opts.periodMs, opts.limit, scopeKey)
			case 'token':
				return await this.tokenBucket(opts.parts, opts.cap, opts.refillPerSec, opts.cost ?? 1, scopeKey)
		}
	}
}

export function getKvRates(host: KvRatesHost): KvRates {
	const existing = (host as unknown as Record<symbol, unknown>)[KV_RATES] as KvRates | undefined
	if (existing) return existing
	const rates = new KvRates(host)
	Object.defineProperty(host, KV_RATES, {
		value: rates,
		writable: false,
		enumerable: false,
		configurable: false,
	})
	return rates
}

export type { KvRateRule, RateDecision, RateParts, RateRule }
