import { BasePlugin, Config, Plugin, pluginMethodDecorator } from '@pluxel/hmr'
import { v } from '@pluxel/hmr/config'
import { RedisPlugin, type RedisSession } from './redis_plugin.js'
import { RateLimitError, type RateDecision, type RateParts, type RateRule } from 'pluxel-plugin-kv'

export const RedisRatesConfigSchema = v.object({
	/** Redis key namespace prefix. */
	namespace: v.optional(v.string(), 'rates'),
})

export type RedisRatesConfig = Config<typeof RedisRatesConfigSchema>

type ScriptName = 'cooldown' | 'fixed' | 'sliding' | 'token'
type ScriptRepo = Record<ScriptName, { source: string; sha: string }>

const SCRIPTS: Record<ScriptName, string> = {
	cooldown: `
-- KEYS[1]=key, ARGV[1]=ttlMs
local ok = redis.call('SET', KEYS[1], '1', 'PX', ARGV[1], 'NX')
if ok then return 1 end
local ms = redis.call('PTTL', KEYS[1])
if ms < 0 then ms = 0 end
return 0 - ms
`,
	fixed: `
-- KEYS[1]=key, ARGV[1]=limit, ARGV[2]=periodSec
local limit = tonumber(ARGV[1])
local period = tonumber(ARGV[2])
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], period) end
local remaining = limit - count
if remaining >= 0 then return remaining end
local ms = redis.call('PTTL', KEYS[1])
if ms < 0 then ms = period * 1000 end
return 0 - ms
`,
	sliding: `
-- KEYS[1]=zkey, ARGV[1]=winMs, ARGV[2]=limit
local win = tonumber(ARGV[1])
local lim = tonumber(ARGV[2])
local t = redis.call('TIME')     -- {sec, usec}
local now = t[1]*1000 + math.floor(t[2]/1000)

redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - win)
local n = redis.call('ZCARD', KEYS[1])
if n < lim then
  redis.call('ZADD', KEYS[1], now, now)
  redis.call('PEXPIRE', KEYS[1], win)
  return lim - n - 1
else
  local pair = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local oldest = pair[2] or now
  local retry = oldest + win - now
  if retry < 0 then retry = 0 end
  return 0 - retry
end
`,
	token: `
-- KEYS[1]=hkey, ARGV[1]=cap, ARGV[2]=refillPerSec, ARGV[3]=cost
local cap = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])

local t = redis.call('TIME') -- server clock
local now = t[1]*1000 + math.floor(t[2]/1000)

local data = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1]) or cap
local last = tonumber(data[2]) or now

if now > last then
  local add = (now - last) * refill / 1000.0
  tokens = math.min(cap, tokens + add)
end

if tokens >= cost then
  tokens = tokens - cost
  redis.call('HMSET', KEYS[1], 'tokens', tokens, 'ts', now)
  local ttl = math.ceil( math.max(1000, cap/refill*1000) )
  redis.call('PEXPIRE', KEYS[1], ttl)
  return math.floor(tokens)
else
  local need = cost - tokens
  local waitMs = math.ceil(need / refill * 1000.0)
  redis.call('HMSET', KEYS[1], 'tokens', tokens, 'ts', now)
  return 0 - waitMs
end
`,
}

/**
 * Redis-optimized rate limiting (atomic, distributed-safe).
 *
 * Uses Lua scripts + Redis server time, so it works correctly across multiple instances.
 */
@Plugin({ name: 'RedisRates', type: 'service' })
export class RedisRates extends BasePlugin {
	@Config(RedisRatesConfigSchema)
	private config!: RedisRatesConfig

	constructor(private redis: RedisPlugin) {
		super()
	}

	private namespace = 'rates'
	private scriptsLoaded = false
	private scripts: ScriptRepo = {
		cooldown: { source: SCRIPTS.cooldown, sha: '' },
		fixed: { source: SCRIPTS.fixed, sha: '' },
		sliding: { source: SCRIPTS.sliding, sha: '' },
		token: { source: SCRIPTS.token, sha: '' },
	}

	private requireCallerScopeKey(method: string): string {
		const callerId = this.ctx.caller?.pluginInfo?.id
		if (!callerId) {
			throw new Error(`[RedisRates] ${method}() requires caller context (call it inside a plugin)`)
		}
		return callerId
	}

	private key(kind: string, parts: Array<string | number>, scopeKey?: string): string {
		const scope = scopeKey ?? this.requireCallerScopeKey('key')
		return `${this.namespace}:${scope}:${kind}:${parts.join(':')}`
	}

	/**
	 * Ensure scripts are loaded.
	 *
	 * `init()` loads them, but this makes the plugin usable in tests even when `init` isn't run.
	 */
	private async ensureScripts(): Promise<void> {
		if (this.scriptsLoaded) return
		this.namespace = this.config.namespace
		await this.redis.use(async (c) => {
			for (const name of Object.keys(this.scripts) as ScriptName[]) {
				this.scripts[name].sha = await c.scriptLoad(this.scripts[name].source)
			}
		})
		this.scriptsLoaded = true
	}

	override async init(): Promise<void> {
		await this.ensureScripts()
		this.ctx.logger.info('[RedisRates] scripts loaded')
	}

	private async evalShaWithReload<T>(
		which: ScriptName,
		run: (c: RedisSession, sha: string) => Promise<T>,
	): Promise<T> {
		const script = this.scripts[which]
		try {
			return await this.redis.use((c) => run(c, script.sha))
		} catch (e: any) {
			const msg = String(e?.message || e)
			if (!msg.includes('NOSCRIPT')) throw e
			this.ctx.logger.info(`[RedisRates] ${which}: NOSCRIPT -> reload`)
			await this.redis.use(async (c) => {
				script.sha = await c.scriptLoad(script.source)
			})
			return await this.redis.use((c) => run(c, script.sha))
		}
	}

	/** Cooldown: ok -> `{ok:true}`; blocked -> `{ok:false,retryAfterMs}` */
	async cooldown(parts: Array<string | number>, ttlMs: number, scopeKey?: string): Promise<RateDecision> {
		await this.ensureScripts()
		const k = this.key('cool', parts, scopeKey)
		const r = await this.evalShaWithReload<number>('cooldown', (c, sha) =>
			c.evalSha(sha, { keys: [k], arguments: [ttlMs] }),
		)
		if (Number(r) === 1) return { ok: true }
		return { ok: false, retryAfterMs: Math.max(0, -Number(r)) }
	}

	/** Fixed window (ms): ok -> `{ok:true,remaining}`; blocked -> `{ok:false,retryAfterMs}` */
	async fixedWindow(
		parts: Array<string | number>,
		periodMs: number,
		limit: number,
		scopeKey?: string,
	): Promise<RateDecision> {
		await this.ensureScripts()
		const periodSec = Math.max(1, Math.ceil(Number(periodMs) / 1000))
		const k = this.key('fixed', parts, scopeKey)
		const left = await this.evalShaWithReload<number>('fixed', (c, sha) =>
			c.evalSha(sha, { keys: [k], arguments: [limit, periodSec] }),
		)
		const n = Number(left)
		return n >= 0 ? { ok: true, remaining: n } : { ok: false, retryAfterMs: Math.max(0, -n) }
	}

	/** Sliding window: remaining >= 0 ok; else blocked with retryAfterMs. */
	async slidingWindow(
		parts: Array<string | number>,
		windowMs: number,
		limit: number,
		scopeKey?: string,
	): Promise<RateDecision> {
		await this.ensureScripts()
		const k = this.key('slide', parts, scopeKey)
		const ret = await this.evalShaWithReload<number>('sliding', (c, sha) =>
			c.evalSha(sha, { keys: [k], arguments: [windowMs, limit] }),
		)
		const n = Number(ret)
		return n >= 0 ? { ok: true, remaining: n } : { ok: false, retryAfterMs: -n }
	}

	/** Token bucket: remaining >= 0 ok; else blocked with retryAfterMs. */
	async tokenBucket(
		parts: Array<string | number>,
		cap: number,
		refillPerSec: number,
		cost = 1,
		scopeKey?: string,
	): Promise<RateDecision> {
		await this.ensureScripts()
		const k = this.key('token', parts, scopeKey)
		const ret = await this.evalShaWithReload<number>('token', (c, sha) =>
			c.evalSha(sha, { keys: [k], arguments: [cap, refillPerSec, cost] }),
		)
		const n = Number(ret)
		return n >= 0 ? { ok: true, remaining: n } : { ok: false, retryAfterMs: -n }
	}

	/** Unified entrypoint. */
	async guard(
		opts:
			| { type: 'cooldown'; parts: Array<string | number>; ttlMs: number }
			| { type: 'fixed'; parts: Array<string | number>; periodMs: number; limit: number }
			| { type: 'sliding'; parts: Array<string | number>; windowMs: number; limit: number }
			| { type: 'token'; parts: Array<string | number>; cap: number; refillPerSec: number; cost?: number },
		scopeKey?: string,
	): Promise<RateDecision> {
		switch (opts.type) {
			case 'cooldown':
				return await this.cooldown(opts.parts, opts.ttlMs, scopeKey)
			case 'fixed':
				return await this.fixedWindow(opts.parts, opts.periodMs, opts.limit, scopeKey)
			case 'sliding':
				return await this.slidingWindow(opts.parts, opts.windowMs, opts.limit, scopeKey)
			case 'token':
				return await this.tokenBucket(opts.parts, opts.cap, opts.refillPerSec, opts.cost ?? 1, scopeKey)
		}
	}
}

export default RedisRates

export type RedisRateGuardOptions<Self, Args extends any[]> = {
	rule: RateRule | ((self: Self, args: Args, method: string) => RateRule)
	parts: (self: Self, args: Args, method: string) => RateParts
	scopeKey?: string | ((self: Self, args: Args, method: string) => string)
}

/**
 * Decorator that guards a method with `RedisRates`.
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
export function RateGuard<Self, Args extends any[]>(
	options: RedisRateGuardOptions<Self, Args>,
): MethodDecorator {
	return pluginMethodDecorator(RedisRates, async function (original, rates: RedisRates, key, ...args: any[]) {
		const typedArgs = args as unknown as Args
		const method = String(key)
		const rule =
			typeof options.rule === 'function' ? options.rule(this as any, typedArgs, method) : options.rule
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
					: rule.type === 'sliding'
						? await rates.slidingWindow(parts, rule.windowMs, rule.limit, scopeKey)
						: await rates.tokenBucket(parts, rule.cap, rule.refillPerSec, rule.cost ?? 1, scopeKey)
		if (!decision.ok) {
			const callerId = (this as any)?.ctx?.pluginInfo?.id
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
	})
}
