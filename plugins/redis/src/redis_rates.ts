import { pluginMethodDecorator } from '@pluxel/hmr'
import { RateLimitError, type RateParts, type RateRule } from 'pluxel-plugin-kv'
import { RedisPlugin } from './redis_plugin.js'

export { RedisRates } from './redis_rates_impl.js'
export type { RedisRatesHost } from './redis_rates_impl.js'

export type RedisRateGuardOptions<Self, Args extends unknown[]> = {
	rule: RateRule | ((self: Self, args: Args, method: string) => RateRule)
	parts: (self: Self, args: Args, method: string) => RateParts
	scopeKey?: string | ((self: Self, args: Args, method: string) => string)
}

/**
 * Decorator that guards a method with `redis.rates`.
 *
 * - Allowed: runs the original method and returns its value.
 * - Blocked: throws a `RateLimitError` (includes `retryAfterMs`, `remaining`, rule, parts, scopeKey).
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
export function RateGuard<Self, Args extends unknown[]>(
	options: RedisRateGuardOptions<Self, Args>,
): MethodDecorator {
	type WithCtx = { ctx?: { pluginInfo?: { id?: unknown } } }

	return pluginMethodDecorator(
		RedisPlugin,
		async function (original, redis: RedisPlugin, key, ...args: unknown[]) {
			const rates = redis.rates
			const typedArgs = args as unknown as Args
			const method = String(key)
			const rule =
				typeof options.rule === 'function'
					? options.rule(this as unknown as Self, typedArgs, method)
					: options.rule
			const parts = options.parts(this as unknown as Self, typedArgs, method)
			const scopeKey =
				typeof options.scopeKey === 'function'
					? options.scopeKey(this as unknown as Self, typedArgs, method)
					: options.scopeKey

			// Avoid object spreading/allocation on hot path: call the concrete method directly.
			const decision =
				rule.type === 'cooldown'
					? await rates.cooldown(parts, rule.ttlMs, scopeKey)
					: rule.type === 'fixed'
						? await rates.fixedWindow(parts, rule.periodMs, rule.limit, scopeKey)
						: rule.type === 'sliding'
							? await rates.slidingWindow(parts, rule.windowMs, rule.limit, scopeKey)
							: await rates.tokenBucket(
									parts,
									rule.cap,
									rule.refillPerSec,
									rule.cost ?? 1,
									scopeKey,
								)
			if (!decision.ok) {
				const callerIdRaw = (this as unknown as WithCtx)?.ctx?.pluginInfo?.id
				const callerId = callerIdRaw == null ? undefined : String(callerIdRaw)
				throw new RateLimitError({
					source: 'redis',
					decision,
					rule,
					parts,
					scopeKey,
					callerId,
					method,
				})
			}

			return await original.apply(this, typedArgs)
		},
	)
}
