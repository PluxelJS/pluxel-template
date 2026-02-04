import type { RateDecision, RateParts, RateRule } from 'pluxel-plugin-kv'
import type { RedisSession } from './redis_plugin.js'

export type RedisRatesHost = {
	ctx: {
		caller?: { pluginInfo?: { id?: unknown } }
		logger: { info: (message: string, props?: Record<string, unknown>) => void }
	}
	use: <T>(fn: (session: RedisSession) => Promise<T>) => Promise<T>
	/**
	 * Return the shared "root" instance for storing script cache/state.
	 *
	 * When a plugin is injected as a dependency, Pluxel wraps it with a caller-injected view
	 * (delegation + overridden `ctx`). Writing state to the view would shadow the prototype,
	 * so we keep shared rate state on the root instance.
	 */
	__ratesRoot: () => { use: RedisRatesHost['use']; ctx: RedisRatesHost['ctx'] }
}

export const REDIS_RATES = Symbol.for('pluxel:redis:rates')
const REDIS_RATES_CORE = Symbol.for('pluxel:redis:rates:core')

type ScriptName = 'cooldown' | 'fixed' | 'sliding' | 'token'
type ScriptRepo = Record<ScriptName, { source: string; sha: string }>
type CoreState = {
	namespace: string
	scriptsLoaded: boolean
	scripts: ScriptRepo
}

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

function getCore(root: RedisRatesHost['__ratesRoot'] extends () => infer R ? R : never): CoreState {
	const record = root as unknown as Record<symbol, unknown>
	const existing = record[REDIS_RATES_CORE] as CoreState | undefined
	if (existing) return existing
	const core: CoreState = {
		namespace: 'rates',
		scriptsLoaded: false,
		scripts: {
			cooldown: { source: SCRIPTS.cooldown, sha: '' },
			fixed: { source: SCRIPTS.fixed, sha: '' },
			sliding: { source: SCRIPTS.sliding, sha: '' },
			token: { source: SCRIPTS.token, sha: '' },
		},
	}
	Object.defineProperty(record, REDIS_RATES_CORE, {
		value: core,
		writable: false,
		enumerable: false,
		configurable: false,
	})
	return core
}

/**
 * Redis-optimized rate limiting (atomic, distributed-safe).
 *
 * Uses Lua scripts + Redis server time, so it works correctly across multiple instances.
 */
export class RedisRates {
	constructor(private readonly host: RedisRatesHost) {}

	private core(): CoreState {
		return getCore(this.host.__ratesRoot())
	}

	private requireCallerScopeKey(method: string): string {
		const callerId = this.host.ctx.caller?.pluginInfo?.id
		if (!callerId) {
			throw new Error(`[redis.rates] ${method}() requires caller context (call it inside a plugin)`)
		}
		return String(callerId)
	}

	private key(kind: string, parts: RateParts, scopeKey?: string): string {
		const core = this.core()
		const scope = scopeKey ?? this.requireCallerScopeKey('key')
		return `${core.namespace}:${scope}:${kind}:${parts.join(':')}`
	}

	private async ensureScripts(): Promise<void> {
		const root = this.host.__ratesRoot()
		const core = this.core()
		if (core.scriptsLoaded) return

		await root.use(async (c) => {
			for (const name of Object.keys(core.scripts) as ScriptName[]) {
				core.scripts[name].sha = await c.scriptLoad(core.scripts[name].source)
			}
		})
		core.scriptsLoaded = true
	}

	private async evalShaWithReload<T>(
		which: ScriptName,
		run: (c: RedisSession, sha: string) => Promise<T>,
	): Promise<T> {
		const root = this.host.__ratesRoot()
		const core = this.core()
		const script = core.scripts[which]
		try {
			return await root.use((c) => run(c, script.sha))
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e)
			if (!msg.includes('NOSCRIPT')) throw e
			this.host.ctx.logger.info('NOSCRIPT -> reload ({which})', { which })
			await root.use(async (c) => {
				script.sha = await c.scriptLoad(script.source)
			})
			return await root.use((c) => run(c, script.sha))
		}
	}

	/** Cooldown: ok -> `{ok:true}`; blocked -> `{ok:false,retryAfterMs}` */
	async cooldown(parts: RateParts, ttlMs: number, scopeKey?: string): Promise<RateDecision> {
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
		parts: RateParts,
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
		parts: RateParts,
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
		parts: RateParts,
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
			| { type: 'cooldown'; parts: RateParts; ttlMs: number }
			| { type: 'fixed'; parts: RateParts; periodMs: number; limit: number }
			| { type: 'sliding'; parts: RateParts; windowMs: number; limit: number }
			| {
					type: 'token'
					parts: RateParts
					cap: number
					refillPerSec: number
					cost?: number
			  },
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
				return await this.tokenBucket(
					opts.parts,
					opts.cap,
					opts.refillPerSec,
					opts.cost ?? 1,
					scopeKey,
				)
		}
	}
}

export function getRedisRates(host: RedisRatesHost): RedisRates {
	const record = host as unknown as Record<symbol, unknown>
	const existing = record[REDIS_RATES] as RedisRates | undefined
	if (existing) return existing
	const rates = new RedisRates(host)
	Object.defineProperty(record, REDIS_RATES, {
		value: rates,
		writable: false,
		enumerable: false,
		configurable: false,
	})
	return rates
}

