import { pluginMethodDecorator } from '@pluxel/hmr'
import { Kv } from './core.js'
import { RateLimitError } from './rates_types.js'
import type { RateGuardOptions } from './rates_types.js'

export * from './rates_types'
export type { KvRates, RatesApi } from './kv_rates'

/**
 * Decorator that guards a method with `kv.rates`.
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
export function RateGuard<Self, Args extends unknown[]>(
	options: RateGuardOptions<Self, Args>,
): MethodDecorator {
	type WithCtx = { ctx?: { pluginInfo?: { id?: unknown } } }

	return pluginMethodDecorator(
		Kv,
		async function (original, kv: Kv, key, ...args: unknown[]) {
			const rates = kv.rates
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
						: await rates.tokenBucket(parts, rule.cap, rule.refillPerSec, rule.cost ?? 1, scopeKey)
			if (!decision.ok) {
				const callerIdRaw = (this as unknown as WithCtx)?.ctx?.pluginInfo?.id
				const callerId = callerIdRaw == null ? undefined : String(callerIdRaw)
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
		},
	)
}
