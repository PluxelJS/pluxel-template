import type { KvScopeKey } from './types.js'

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
	 * Used by `pluxel-plugin-redis` (`redis.rates.slidingWindow()`).
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
	return !!(
		err &&
		typeof err === 'object' &&
		(err as { [RATE_LIMIT_ERROR]?: unknown })[RATE_LIMIT_ERROR]
	)
}

export type RateGuardOptions<Self, Args extends unknown[]> = {
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

