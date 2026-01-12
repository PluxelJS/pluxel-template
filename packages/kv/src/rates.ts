import { BasePlugin, Config, Plugin, pluginMethodDecorator } from '@pluxel/hmr'
import { v } from '@pluxel/hmr/config'
import { Kv } from './core.js'
import type { KvScopeKey } from './types.js'

export const RatesConfigSchema = v.object({
	/** Key namespace inside the caller scope. */
	namespace: v.optional(v.string(), 'rates'),
})

export type RatesConfig = Config<typeof RatesConfigSchema>

export type RateDecision =
	| { ok: true; remaining?: number }
	| { ok: false; retryAfterMs: number; remaining?: number }
export type RateAllowed = Extract<RateDecision, { ok: true }>
export type RateBlocked = Extract<RateDecision, { ok: false }>
export type RateParts = Array<string | number>

export type RateRule =
	| { type: 'cooldown'; ttlMs: number }
	| { type: 'fixed'; periodMs: number; limit: number }
	| { type: 'token'; cap: number; refillPerSec: number; cost?: number }
	/**
	 * Sliding window rate limit (Redis-only; requires atomic operations).
	 * Used by `pluxel-plugin-redis` (`RedisRates.slidingWindow()`).
	 */
	| { type: 'sliding'; windowMs: number; limit: number }

export type KvRateRule = Exclude<RateRule, { type: 'sliding' }>

const RATE_LIMIT_ERROR = Symbol.for('pluxel:rates:RateLimitError')

export type RateLimitErrorDetails = {
	source: 'kv' | 'redis'
	decision: RateBlocked
	rule: RateRule
	parts: RateParts
	scopeKey?: KvScopeKey
	callerId?: string
	method?: string
}

/**
 * Thrown by rate guard decorators when blocked.
 *
 * The error is tagged via `Symbol.for('pluxel:rates:RateLimitError')` so it can be
 * detected reliably across HMR / multi-bundle scenarios.
 */
export class RateLimitError extends Error {
	readonly [RATE_LIMIT_ERROR] = true
	override readonly name = 'RateLimitError'

	readonly source: RateLimitErrorDetails['source']
	readonly decision: RateBlocked
	readonly rule: RateRule
	readonly parts: RateParts
	readonly scopeKey?: KvScopeKey
	readonly callerId?: string
	readonly method?: string

	get retryAfterMs(): number {
		return this.decision.retryAfterMs
	}
	get remaining(): number | undefined {
		return this.decision.remaining
	}

	constructor(details: RateLimitErrorDetails) {
		const { source, decision, rule, parts, scopeKey, callerId, method } = details
		const msg = [
			'[RateLimit] blocked',
			`source=${source}`,
			`type=${rule.type}`,
			`retryAfterMs=${decision.retryAfterMs}`,
			decision.remaining !== undefined ? `remaining=${decision.remaining}` : '',
			scopeKey ? `scopeKey=${scopeKey}` : '',
			callerId ? `caller=${callerId}` : '',
			method ? `method=${method}` : '',
			parts.length ? `parts=${parts.join(':')}` : '',
		]
			.filter(Boolean)
			.join(' ')
		super(msg)

		this.source = source
		this.decision = decision
		this.rule = rule
		this.parts = parts
		this.scopeKey = scopeKey
		this.callerId = callerId
		this.method = method
	}
}

export function isRateLimitError(err: unknown): err is RateLimitError {
	return !!(err && typeof err === 'object' && (err as any)[RATE_LIMIT_ERROR])
}

export type RateGuardOptions<Self, Args extends any[]> = {
	/**
	 * The rate limit policy.
	 * You can provide a function if it depends on args (e.g. per-plan limits).
	 */
	rule: KvRateRule | ((self: Self, args: Args, method: string) => KvRateRule)

	/** Build parts for the key (should be stable, cheap). */
	parts: (self: Self, args: Args, method: string) => RateParts

	/**
	 * Optional scope key override.
	 * Default is caller plugin id (isolated per plugin).
	 */
	scopeKey?: KvScopeKey | ((self: Self, args: Args, method: string) => KvScopeKey)
}

type CooldownState = { exp: number }
type FixedWindowState = { count: number; resetAt: number }
type TokenBucketState = { tokens: number; ts: number }

/**
 * Best-effort rate limiting built on the KV abstraction.
 *
 * Properties:
 * - Works with any KV backend (memory / redis / ...).
 * - Uses per-process in-flight de-duplication to reduce local stampedes.
 * - Does NOT provide strict distributed guarantees (read-modify-write is not atomic across processes).
 *
 * TTL is used for cleanup when available, but correctness does not depend on TTL: we also store `exp/resetAt/ts`
 * in values so we can compute `retryAfterMs` without backend TTL introspection.
 */
@Plugin({ name: 'Rates', type: 'service' })
export class Rates extends BasePlugin {
	@Config(RatesConfigSchema)
	private config!: RatesConfig

	constructor(private kv: Kv) {
		super()
	}

	private inflight = new Map<string, Promise<any>>()

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
		return `${this.config.namespace}:${kind}:${parts.join(':')}`
	}

	private scope(scopeKey?: KvScopeKey) {
		return this.kv.scope(scopeKey)
	}

	/** Cooldown: ok -> `{ok:true}`; blocked -> `{ok:false,retryAfterMs}` */
	async cooldown(
		parts: Array<string | number>,
		ttlMs: number,
		scopeKey?: KvScopeKey,
	): Promise<RateDecision> {
		if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
			throw new Error('[Rates] cooldown ttlMs must be a positive, finite number')
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
		parts: Array<string | number>,
		periodMs: number,
		limit: number,
		scopeKey?: KvScopeKey,
	): Promise<RateDecision> {
		if (!Number.isFinite(periodMs) || periodMs <= 0) {
			throw new Error('[Rates] fixedWindow periodMs must be a positive, finite number')
		}
		if (!Number.isFinite(limit) || limit <= 0) {
			throw new Error('[Rates] fixedWindow limit must be a positive, finite number')
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
		parts: Array<string | number>,
		cap: number,
		refillPerSec: number,
		cost = 1,
		scopeKey?: KvScopeKey,
	): Promise<RateDecision> {
		if (!Number.isFinite(cap) || cap <= 0) throw new Error('[Rates] tokenBucket cap must be > 0')
		if (!Number.isFinite(refillPerSec) || refillPerSec <= 0) {
			throw new Error('[Rates] tokenBucket refillPerSec must be > 0')
		}
		if (!Number.isFinite(cost) || cost <= 0) throw new Error('[Rates] tokenBucket cost must be > 0')

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
			| { type: 'cooldown'; parts: Array<string | number>; ttlMs: number }
			| { type: 'fixed'; parts: Array<string | number>; periodMs: number; limit: number }
			| {
					type: 'token'
					parts: Array<string | number>
					cap: number
					refillPerSec: number
					cost?: number
			  },
		scopeKey?: KvScopeKey,
	): Promise<RateDecision> {
		switch (opts.type) {
			case 'cooldown':
				return await this.cooldown(opts.parts, opts.ttlMs, scopeKey)
			case 'fixed':
				return await this.fixedWindow(opts.parts, opts.periodMs, opts.limit, scopeKey)
			case 'token':
				return await this.tokenBucket(
					opts.parts,
					opts.cap,
					opts.refillPerSec,
					opts.cost ?? 1,
					scopeKey,
				)
		}
	}

	protected override async stop(_abort: AbortSignal): Promise<void> {
		this.inflight.clear()
	}
}

export default Rates

/**
 * Decorator that guards a method with `Rates`.
 *
 * - Allowed: runs the original method and returns its value.
 * - Blocked: throws a `RateLimitError` (includes `retryAfterMs`, `remaining`, rule, parts, scopeKey).
 *
 * Usage:
 * ```ts
 * @RateGuard({
 *   rule: { type: 'cooldown', ttlMs: 10_000 },
 *   parts: (_self, [userId]) => ['login', userId],
 * })
 * async login(userId: string) { ... }
 * ```
 *
 * Handling:
 * ```ts
 * try {
 *   await foo.login('u1')
 * } catch (e) {
 *   if (isRateLimitError(e)) {
 *     // e.retryAfterMs, e.remaining
 *   }
 * }
 * ```
 */
export function RateGuard<Self, Args extends any[]>(
	options: RateGuardOptions<Self, Args>,
): MethodDecorator {
	return pluginMethodDecorator(Rates, async function (original, rates: Rates, key, ...args: any[]) {
		const typedArgs = args as unknown as Args
		const method = String(key)
		const rule =
			typeof options.rule === 'function'
				? options.rule(this as any, typedArgs, method)
				: options.rule
		const parts = options.parts(this as any, typedArgs, method)
		const scopeKey =
			typeof options.scopeKey === 'function'
				? options.scopeKey(this as any, typedArgs, method)
				: options.scopeKey

		// Avoid object spreading/allocation on hot path: call the concrete method directly.
		const decision =
			rule.type === 'cooldown'
				? await rates.cooldown(parts, rule.ttlMs, scopeKey)
				: rule.type === 'fixed'
					? await rates.fixedWindow(parts, rule.periodMs, rule.limit, scopeKey)
					: await rates.tokenBucket(parts, rule.cap, rule.refillPerSec, rule.cost ?? 1, scopeKey)
		if (!decision.ok) {
			const callerId = (this as any)?.ctx?.pluginInfo?.id
			throw new RateLimitError({
				source: 'kv',
				decision,
				rule,
				parts,
				scopeKey,
				callerId,
				method,
			})
		}

		return await original.apply(this, typedArgs)
	})
}
