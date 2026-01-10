import Redis, { type RedisOptions } from 'ioredis'
import { Config, Plugin } from '@pluxel/hmr'
import { v } from '@pluxel/hmr/config'
import { Kv, type KvDriver, type KvDriverSetOptions, type KvValue } from 'pluxel-plugin-kv'

export const RedisConfigSchema = v.object({
	/** Connection URL: redis://localhost:6379/0 */
	url: v.optional(v.string()),

	/**
	 * Optional key prefix (namespacing).
	 * Note: this is NOT applied automatically to commands; it's for helpers.
	 */
	keyPrefix: v.optional(v.string(), ''),

	/** Lazy connect (default). */
	lazyConnect: v.optional(v.boolean(), true),
})

export type RedisConfig = Config<typeof RedisConfigSchema>

export type RedisEvalShaOptions = {
	keys?: string[]
	arguments?: Array<string | number>
}

export type RedisSession = {
	raw: Redis
	scriptLoad: (script: string) => Promise<string>
	evalSha: <T = unknown>(sha: string, options?: RedisEvalShaOptions) => Promise<T>
}

@Plugin(Kv, { name: 'Redis', type: 'service' })
export class RedisPlugin extends Kv {
	@Config(RedisConfigSchema)
	private config!: RedisConfig

	private parsed:
		| {
				url?: string
				keyPrefix: string
				lazyConnect: boolean
		  }
		| undefined
	private client: Redis | undefined
	private session: RedisSession | undefined
	private kvDriver: KvDriver | undefined

	private ensureConfig(): { url?: string; keyPrefix: string; lazyConnect: boolean } {
		if (this.parsed) return this.parsed
		const cfg = this.config
		this.parsed = {
			url: cfg.url,
			keyPrefix: normalizeKeyPrefix(cfg.keyPrefix),
			lazyConnect: cfg.lazyConnect,
		}
		return this.parsed
	}

	get keyPrefix(): string {
		return this.ensureConfig().keyPrefix
	}

	private ensureClient(): Redis {
		if (this.client) return this.client
		const cfg = this.ensureConfig()
		if (!cfg.url) {
			throw new Error('[Redis] missing config: url')
		}

		const options: RedisOptions = { lazyConnect: cfg.lazyConnect }
		this.client = new Redis(cfg.url, options)
		this.session = {
			raw: this.client,
			scriptLoad: async (script: string) => String(await this.client!.script('LOAD', script)),
				evalSha: async <T = unknown>(sha: string, options: RedisEvalShaOptions = {}) => {
					const keys = options.keys ?? []
					const args = (options.arguments ?? []).map(String)
					// ioredis: evalsha(sha, numKeys, ...keys, ...args)
					return (await this.client!.evalsha(sha, keys.length, ...keys, ...args)) as T
				},
			}

		return this.client
	}

	async use<T>(fn: (session: RedisSession) => Promise<T>): Promise<T> {
		this.ensureClient()
		return await fn(this.session!)
	}

	protected override driver(): KvDriver {
		this.ensureClient()
		this.kvDriver ??= this.createKvDriver()
		return this.kvDriver
	}

	protected override async stop(_abort: AbortSignal): Promise<void> {
		if (!this.client) return
		try {
			await this.client.quit()
		} catch {
			this.client.disconnect()
		}
		this.client = undefined
		this.session = undefined
		this.kvDriver = undefined
		this.parsed = undefined
	}

	private createKvDriver(): KvDriver {
		const encode = (value: KvValue) => JSON.stringify(value)
		const decode = (raw: string): unknown => {
			try {
				return JSON.parse(raw)
			} catch {
				return raw
			}
		}

		const toRedisKey = (key: string) => `${this.keyPrefix}${key}`
		const fromRedisKey = (key: string) =>
			key.startsWith(this.keyPrefix) ? key.slice(this.keyPrefix.length) : key

		const scanKeys = async (base: string = ''): Promise<string[]> => {
			const pattern = `${this.keyPrefix}${base}*`
			const out = new Set<string>()
			await this.use(async ({ raw }) => {
				let cursor = '0'
				do {
					const res = (await raw.scan(cursor, 'MATCH', pattern, 'COUNT', '1000')) as [string, string[]]
					cursor = res[0]
					for (const key of res[1]) {
						if (key.endsWith('$')) continue
						out.add(fromRedisKey(key))
					}
				} while (cursor !== '0')
			})
			return [...out]
		}

		return {
			hasItem: async (key: string) => {
				return await this.use(async ({ raw }) => {
					const n = await raw.exists(toRedisKey(key))
					return Number(n) > 0
				})
			},
			getItem: async <T = unknown>(key: string) => {
				return await this.use(async ({ raw }) => {
					const v = await raw.get(toRedisKey(key))
					if (v == null) return null
					return decode(v) as T
				})
			},
			setItem: async (key: string, value: KvValue, options?: KvDriverSetOptions) => {
				const ttl = options?.ttl
				await this.use(async ({ raw }) => {
					const k = toRedisKey(key)
					const v = encode(value)
					if (ttl === undefined) {
						await raw.set(k, v)
						return
					}
					const ttlSeconds = Math.max(1, Math.ceil(Number(ttl)))
					await raw.set(k, v, 'EX', String(ttlSeconds))
				})
			},
			removeItem: async (key: string) => {
				await this.use(async ({ raw }) => {
					await raw.del(toRedisKey(key))
				})
			},
			getKeys: async (base?: string) => {
				return await scanKeys(base ?? '')
			},
			clear: async (base?: string) => {
				const keys = await scanKeys(base ?? '')
				if (!keys.length) return
				await this.use(async ({ raw }) => {
					const chunkSize = 500
					for (let i = 0; i < keys.length; i += chunkSize) {
						const slice = keys.slice(i, i + chunkSize).map(toRedisKey)
						await raw.del(...slice)
					}
				})
			},
		}
	}
}

export default RedisPlugin

function normalizeKeyPrefix(prefix: unknown): string {
	const trimmed = String(prefix ?? '').trim()
	if (!trimmed) return ''
	return trimmed.endsWith(':') ? trimmed : `${trimmed}:`
}
