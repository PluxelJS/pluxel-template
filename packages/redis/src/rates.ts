import { BasePlugin, Config, Plugin } from '@pluxel/hmr'
import { v } from '@pluxel/hmr/config'
import { RedisPlugin, type RedisSession } from './redis_plugin.js'

/** —— 配置（通用前缀 + 合理默认） —— */
export const RatesConfigSchema = v.object({
	/** Redis key 前缀命名空间 */
	namespace: v.optional(v.string(), 'rates'),
})
export type RatesConfig = Config<typeof RatesConfigSchema>

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
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2])) end
return limit - count
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

@Plugin({ name: 'Rates', type: 'service' })
export class Rates extends BasePlugin {
	@Config(RatesConfigSchema)
	private config!: RatesConfig

	constructor(private redis: RedisPlugin) {
		super()
	}

	private namespace = 'rates'

	private scripts: ScriptRepo = {
		cooldown: { source: SCRIPTS.cooldown, sha: '' },
		fixed: { source: SCRIPTS.fixed, sha: '' },
		sliding: { source: SCRIPTS.sliding, sha: '' },
		token: { source: SCRIPTS.token, sha: '' },
	}

	/** 统一 key 生成：<ns>:<kind>:<...parts> */
	private key(kind: string, ...parts: (string | number)[]) {
		return `${this.namespace}:${kind}:${parts.join(':')}`
	}

	override async init(): Promise<void> {
		this.namespace = this.config.namespace
		await this.loadAllScripts()
		this.ctx.logger.info('[Rates] scripts loaded')
	}

	private async loadAllScripts(): Promise<void> {
		await this.redis.use(async (c) => {
			for (const name of Object.keys(this.scripts) as ScriptName[]) {
				this.scripts[name].sha = await c.scriptLoad(this.scripts[name].source)
			}
		})
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
			this.ctx.logger.info(`[Rates] ${which}: NOSCRIPT -> reload`)
			await this.redis.use(async (c) => {
				script.sha = await c.scriptLoad(script.source)
			})
			return await this.redis.use((c) => run(c, script.sha))
		}
	}

	/** 固定冷却：允许 -> {ok:true}；冷却中 -> {ok:false, retryAfterMs} */
	async guardCooldown(parts: (string | number)[], ttlMs: number) {
		const k = this.key('cool', ...parts)
		const r = await this.evalShaWithReload<number>('cooldown', (c, sha) =>
			c.evalSha(sha, { keys: [k], arguments: [ttlMs] }),
		)
		if (Number(r) === 1) return { ok: true as const }
		return { ok: false as const, retryAfterMs: Math.max(0, -Number(r)) }
	}

	/** 固定窗口：periodSec 内 limit 次。返回剩余；<0 表示已超限 */
	async consumeFixed(parts: (string | number)[], periodSec: number, limit: number) {
		const k = this.key('fixed', ...parts)
		const left = await this.evalShaWithReload<number>('fixed', (c, sha) =>
			c.evalSha(sha, { keys: [k], arguments: [limit, periodSec] }),
		)
		return Number(left)
	}

	/** 滑动窗口：windowMs 内 limit 次。>=0 剩余；<0 需等待毫秒 */
	async consumeSliding(parts: (string | number)[], windowMs: number, limit: number) {
		const k = this.key('slide', ...parts)
		const ret = await this.evalShaWithReload<number>('sliding', (c, sha) =>
			c.evalSha(sha, { keys: [k], arguments: [windowMs, limit] }),
		)
		return Number(ret)
	}

	/** 令牌桶：cap 容量，refill 每秒补充，cost 每次消耗。>=0 剩余；<0 需等待毫秒 */
	async consumeToken(parts: (string | number)[], cap: number, refillPerSec: number, cost = 1) {
		const k = this.key('token', ...parts)
		const ret = await this.evalShaWithReload<number>('token', (c, sha) =>
			c.evalSha(sha, { keys: [k], arguments: [cap, refillPerSec, cost] }),
		)
		return Number(ret)
	}

	/** 统一守卫：策略抽象，返回结构化结果 */
	async guard(
		opts:
			| { type: 'cooldown'; parts: (string | number)[]; ttlMs: number }
			| { type: 'fixed'; parts: (string | number)[]; periodSec: number; limit: number }
			| { type: 'sliding'; parts: (string | number)[]; windowMs: number; limit: number }
			| { type: 'token'; parts: (string | number)[]; cap: number; refillPerSec: number; cost?: number },
	): Promise<{ ok: true; remaining?: number } | { ok: false; retryAfterMs: number; remaining?: number }> {
		switch (opts.type) {
			case 'cooldown': {
				const r = await this.guardCooldown(opts.parts, opts.ttlMs)
				return r.ok ? r : { ok: false, retryAfterMs: r.retryAfterMs }
			}
			case 'fixed': {
				const left = await this.consumeFixed(opts.parts, opts.periodSec, opts.limit)
				if (left < 0) return { ok: false, retryAfterMs: 0, remaining: left }
				return { ok: true, remaining: left }
			}
			case 'sliding': {
				const r = await this.consumeSliding(opts.parts, opts.windowMs, opts.limit)
				return r >= 0 ? { ok: true, remaining: r } : { ok: false, retryAfterMs: -r }
			}
			case 'token': {
				const r = await this.consumeToken(opts.parts, opts.cap, opts.refillPerSec, opts.cost ?? 1)
				return r >= 0 ? { ok: true, remaining: r } : { ok: false, retryAfterMs: -r }
			}
		}
	}

	makeKey(kind: 'cool' | 'fixed' | 'slide' | 'token', ...parts: (string | number)[]) {
		return this.key(kind, ...parts)
	}
}

export default Rates
