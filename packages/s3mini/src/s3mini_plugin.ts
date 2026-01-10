import { BasePlugin, Config, Plugin } from '@pluxel/hmr'
import { v } from '@pluxel/hmr/config'
import { S3mini, type AWSHeaders, type ExistResponseCode, type Logger, type S3Config } from 's3mini'

export type { AWSHeaders, ExistResponseCode, Logger, S3Config }
export { S3mini }

export const S3MiniPluginConfigSchema = v.object({
	/**
	 * S3 endpoint (URL).
	 *
	 * You can provide:
	 * - bucket endpoint (recommended): `https://<bucket>.<region>.digitaloceanspaces.com`
	 * - or base endpoint: `https://s3.us-east-1.amazonaws.com` + `bucket` + `endpointStyle`
	 */
	endpoint: v.string(),

	/** Optional bucket name, used to compose bucket endpoint when `endpoint` is base endpoint. */
	bucket: v.optional(v.string()),

	/**
	 * How to combine `endpoint` + `bucket` when endpoint doesn't already include the bucket.
	 * - `path`: `https://host/<bucket>`
	 * - `virtualHost`: `https://<bucket>.host/`
	 * - `auto`: defaults to `path`
	 */
	endpointStyle: v.optional(v.picklist(['auto', 'path', 'virtualHost']), 'auto'),

	/** Default: `auto` (same default as s3mini). */
	region: v.optional(v.string(), 'auto'),

	/** If omitted, will try env: `AWS_ACCESS_KEY_ID` / `S3_ACCESS_KEY_ID`. */
	accessKeyId: v.optional(v.string()),
	/** If omitted, will try env: `AWS_SECRET_ACCESS_KEY` / `S3_SECRET_ACCESS_KEY`. */
	secretAccessKey: v.optional(v.string()),

	/** Default: 8MB (same default as s3mini). */
	requestSizeInBytes: v.optional(v.number(), 8 * 1024 * 1024),
	/** Optional abort timeout in milliseconds (s3mini `requestAbortTimeout`). */
	requestAbortTimeout: v.optional(v.number()),

	/** Default: false. When enabled, forwards s3mini logs to `this.ctx.logger`. */
	logger: v.optional(v.boolean(), false),

	/**
	 * Base key prefix for all object keys (e.g. `app/`).
	 * Useful for multi-tenant buckets or sharing a bucket across apps.
	 */
	keyPrefix: v.optional(v.string(), ''),

	/**
	 * Default: true.
	 * When enabled, `scope()` (without args) uses caller plugin id as prefix.
	 */
	scopeByCaller: v.optional(v.boolean(), true),

	/** Default delimiter for list operations. */
	listDelimiter: v.optional(v.string(), '/'),
	/** Optional default maxKeys for list operations. */
	listMaxKeys: v.optional(v.number()),

	/**
	 * Optional public base URL for building public links, e.g. `https://cdn.example.com/`.
	 * Note: this does NOT sign URLs.
	 */
	publicBaseURL: v.optional(v.string(), ''),
})

export type S3MiniPluginConfig = Config<typeof S3MiniPluginConfigSchema>

export type S3MiniScopeListOptions = {
	delimiter?: string
	prefix?: string
	maxKeys?: number
	opts?: Record<string, unknown>
}

export type S3MiniScopeListPagedOptions = S3MiniScopeListOptions & {
	nextContinuationToken?: string
}

export interface S3MiniScope {
	/** Scope key (usually caller plugin id). */
	key: string
	/** Normalized key prefix for this scope, always empty or ending with `/`. */
	prefix: string

	/** Join and normalize a key under this scope. */
	objectKey: (key: string) => string

	/** Build a public URL (if `publicBaseURL` configured); otherwise returns undefined. */
	publicURL: (key: string) => string | undefined

	getText: (key: string, opts?: Record<string, unknown>) => Promise<string | null>
	getJSON: <T = unknown>(key: string, opts?: Record<string, unknown>) => Promise<T | null>
	getArrayBuffer: (key: string, opts?: Record<string, unknown>) => Promise<ArrayBuffer | null>
	getResponse: (key: string, opts?: Record<string, unknown>) => Promise<Response | null>
	getRaw: (
		key: string,
		options?: {
			wholeFile?: boolean
			rangeFrom?: number
			rangeTo?: number
			opts?: Record<string, unknown>
		},
	) => Promise<Response>

	put: (
		key: string,
		data: Parameters<S3mini['putObject']>[1],
		options?: {
			contentType?: string
			ssecHeaders?: Parameters<S3mini['putObject']>[3]
			additionalHeaders?: AWSHeaders
		},
	) => Promise<Response>

	del: (key: string) => Promise<boolean>
	exists: (key: string, opts?: Record<string, unknown>) => Promise<ExistResponseCode>

	list: (options?: S3MiniScopeListOptions) => Promise<Awaited<ReturnType<S3mini['listObjects']>>>
	listPaged: (
		options?: S3MiniScopeListPagedOptions,
	) => Promise<Awaited<ReturnType<S3mini['listObjectsPaged']>>>
}

type ResolvedConfig = {
	accessKeyId: string
	secretAccessKey: string
	endpoint: string
	region: string
	requestSizeInBytes: number
	requestAbortTimeout?: number
	logger?: Logger
	keyPrefix: string
	scopeByCaller: boolean
	listDelimiter: string
	listMaxKeys?: number
	publicBaseURL?: string
}

@Plugin({ name: 'S3Mini', type: 'service' })
export class S3MiniPlugin extends BasePlugin {
	@Config(S3MiniPluginConfigSchema)
	private config!: S3MiniPluginConfig

	private resolved: ResolvedConfig | undefined
	private client: S3mini | undefined

	protected override init(_abort: AbortSignal): void {
		// Validate config early for faster feedback in dev.
		this.ensureClient()
		this.ctx.logger.info('[S3Mini] ready')
	}

	protected override stop(_abort: AbortSignal): void {
		this.client = undefined
		this.resolved = undefined
	}

	raw(): S3mini {
		return this.ensureClient()
	}

	createClient(overrides: Partial<S3Config> = {}): S3mini {
		const cfg = this.ensureResolved()
		return new S3mini({
			accessKeyId: cfg.accessKeyId,
			secretAccessKey: cfg.secretAccessKey,
			endpoint: cfg.endpoint,
			region: cfg.region,
			requestSizeInBytes: cfg.requestSizeInBytes,
			requestAbortTimeout: cfg.requestAbortTimeout,
			logger: cfg.logger,
			...overrides,
		})
	}

	/**
	 * Get a scoped view:
	 * - `scope()` uses caller plugin id (recommended, if `scopeByCaller=true`).
	 * - `scope('X')` uses explicit scope (scripts/tests/shared namespace).
	 */
	scope(scopeKey?: string): S3MiniScope {
		const cfg = this.ensureResolved()

		const key = scopeKey ?? (cfg.scopeByCaller ? this.requireCallerScopeKey('scope') : '')
		const normalizedScope = normalizeKeyPart(key)
		const prefix = joinPrefix(cfg.keyPrefix, normalizedScope)
		const s3 = this.ensureClient()

		const objectKey = (raw: string) => `${prefix}${normalizeKeyPart(raw)}`
		const publicURL = (raw: string) => {
			if (!cfg.publicBaseURL) return undefined
			const key = objectKey(raw)
			return buildPublicURL(cfg.publicBaseURL, key)
		}

		const listPrefix = (rawPrefix?: string) => {
			const p = normalizePrefixPart(rawPrefix ?? '')
			return `${prefix}${p}`
		}

		return {
			key,
			prefix,
			objectKey,
			publicURL,
			getText: async (k: string, opts?: Record<string, unknown>) => await s3.getObject(objectKey(k), opts),
			getJSON: async <T = unknown>(k: string, opts?: Record<string, unknown>) =>
				await s3.getObjectJSON<T>(objectKey(k), opts),
			getArrayBuffer: async (k: string, opts?: Record<string, unknown>) =>
				await s3.getObjectArrayBuffer(objectKey(k), opts),
			getResponse: async (k: string, opts?: Record<string, unknown>) =>
				await s3.getObjectResponse(objectKey(k), opts),
			getRaw: async (
				k: string,
				options: {
					wholeFile?: boolean
					rangeFrom?: number
					rangeTo?: number
					opts?: Record<string, unknown>
				} = {},
			) =>
				await s3.getObjectRaw(
					objectKey(k),
					options.wholeFile ?? true,
					options.rangeFrom,
					options.rangeTo,
					options.opts,
				),
			put: async (
				k: string,
				data: Parameters<S3mini['putObject']>[1],
				options: {
					contentType?: string
					ssecHeaders?: Parameters<S3mini['putObject']>[3]
					additionalHeaders?: AWSHeaders
				} = {},
			) =>
				await s3.putObject(
					objectKey(k),
					data as any,
					options.contentType,
					options.ssecHeaders,
					options.additionalHeaders,
				),
			del: async (k: string) => await s3.deleteObject(objectKey(k)),
			exists: async (k: string, opts?: Record<string, unknown>) =>
				await s3.objectExists(objectKey(k), opts),
			list: async (options: S3MiniScopeListOptions = {}) =>
				await s3.listObjects(
					options.delimiter ?? cfg.listDelimiter,
					listPrefix(options.prefix),
					options.maxKeys ?? cfg.listMaxKeys,
					options.opts,
				),
			listPaged: async (options: S3MiniScopeListPagedOptions = {}) =>
				await s3.listObjectsPaged(
					options.delimiter ?? cfg.listDelimiter,
					listPrefix(options.prefix),
					options.maxKeys ?? cfg.listMaxKeys,
					options.nextContinuationToken,
					options.opts,
				),
		}
	}

	/** Caller-scope shortcut. */
	getText(key: string, opts?: Record<string, unknown>): Promise<string | null> {
		return this.scope().getText(key, opts)
	}
	/** Caller-scope shortcut. */
	put(
		key: string,
		data: Parameters<S3mini['putObject']>[1],
		options?: Parameters<S3MiniScope['put']>[2],
	): Promise<Response> {
		return this.scope().put(key, data, options)
	}
	/** Caller-scope shortcut. */
	del(key: string): Promise<boolean> {
		return this.scope().del(key)
	}
	/** Caller-scope shortcut. */
	exists(key: string, opts?: Record<string, unknown>): Promise<ExistResponseCode> {
		return this.scope().exists(key, opts)
	}

	private requireCallerScopeKey(method: string): string {
		const callerId = this.ctx.caller?.pluginInfo?.id
		if (!callerId) {
			throw new Error(`[S3Mini] ${method}() requires caller context (call it inside a plugin)`)
		}
		return callerId
	}

	private ensureResolved(): ResolvedConfig {
		if (this.resolved) return this.resolved
		// NOTE:
		// - 在 HMR runtime 中，PluginRegistry 会基于 @Config schema 校验并补齐默认值；
		// - 这里直接使用注入后的 output，避免重复 parse + 类型断言。
		const cfg = this.config

		const { accessKeyId, secretAccessKey } = resolveCredentials(cfg)
		const endpoint = buildBucketEndpoint(cfg.endpoint, cfg.bucket, cfg.endpointStyle)

		const keyPrefix = normalizePrefixPart(cfg.keyPrefix)
		const publicBaseURL = normalizePublicBaseURL(cfg.publicBaseURL)

		const logger = cfg.logger ? this.createLoggerAdapter() : undefined

		this.resolved = {
			accessKeyId,
			secretAccessKey,
			endpoint,
			region: cfg.region,
			requestSizeInBytes: cfg.requestSizeInBytes,
			requestAbortTimeout: cfg.requestAbortTimeout,
			logger,
			keyPrefix,
			scopeByCaller: cfg.scopeByCaller,
			listDelimiter: cfg.listDelimiter,
			listMaxKeys: cfg.listMaxKeys,
			publicBaseURL,
		}
		return this.resolved
	}

	private ensureClient(): S3mini {
		if (this.client) return this.client
		const cfg = this.ensureResolved()
		this.client = new S3mini({
			accessKeyId: cfg.accessKeyId,
			secretAccessKey: cfg.secretAccessKey,
			endpoint: cfg.endpoint,
			region: cfg.region,
			requestSizeInBytes: cfg.requestSizeInBytes,
			requestAbortTimeout: cfg.requestAbortTimeout,
			logger: cfg.logger,
		})
		return this.client
	}

	private createLoggerAdapter(): Logger {
		return {
			info: (message: string, ...args: unknown[]) => this.ctx.logger.info(message, ...args),
			warn: (message: string, ...args: unknown[]) => this.ctx.logger.warn(message, ...args),
			error: (message: string, ...args: unknown[]) => this.ctx.logger.error(message, ...args),
		}
	}
}

function resolveCredentials(cfg: S3MiniPluginConfig): {
	accessKeyId: string
	secretAccessKey: string
} {
	const env = getEnv()

	const accessKeyId =
		cfg.accessKeyId ??
		env.AWS_ACCESS_KEY_ID ??
		env.S3_ACCESS_KEY_ID ??
		env.AWS_ACCESS_KEY ??
		env.S3_ACCESS_KEY ??
		''
	const secretAccessKey =
		cfg.secretAccessKey ??
		env.AWS_SECRET_ACCESS_KEY ??
		env.S3_SECRET_ACCESS_KEY ??
		env.AWS_SECRET_KEY ??
		env.S3_SECRET_KEY ??
		''

	if (!accessKeyId) throw new Error('[S3Mini] missing credentials: accessKeyId')
	if (!secretAccessKey) throw new Error('[S3Mini] missing credentials: secretAccessKey')

	return { accessKeyId, secretAccessKey }
}

function getEnv(): Record<string, string | undefined> {
	const p = typeof process !== 'undefined' ? (process as any) : undefined
	return (p?.env as any) ?? {}
}

function buildBucketEndpoint(
	endpoint: string,
	bucket: string | undefined,
	endpointStyle: 'auto' | 'path' | 'virtualHost',
): string {
	const url = new URL(endpoint)
	const b = (bucket ?? '').trim()
	if (!b) return url.toString()

	// If endpoint already contains bucket, keep it.
	const firstPathSeg = url.pathname.replace(/^\/+/, '').split('/')[0] ?? ''
	if (url.hostname.startsWith(`${b}.`) || firstPathSeg === b) return url.toString()

	const style = endpointStyle === 'auto' ? 'path' : endpointStyle
	if (style === 'virtualHost') {
		url.hostname = `${b}.${url.hostname}`
		return url.toString()
	}

	// path style: append bucket as first segment
	const basePath = url.pathname.replace(/\/+$/g, '')
	url.pathname = `${basePath}/${b}`.replace(/\/+/g, '/')
	return url.toString()
}

function normalizeKeyPart(key: string): string {
	if (!key) return ''
	return (
		key
			.split('?')[0]
			?.replace(/\\/g, '/')
			.replace(/\/+/g, '/')
			.replace(/^\/|\/$/g, '') || ''
	)
}

function normalizePrefixPart(prefix: string): string {
	const p = normalizeKeyPart(prefix)
	return p ? `${p}/` : ''
}

function joinPrefix(basePrefix: string, scopeKey: string): string {
	const base = normalizePrefixPart(basePrefix)
	const scope = normalizePrefixPart(scopeKey)
	return `${base}${scope}`
}

function normalizePublicBaseURL(raw: string): string | undefined {
	const s = String(raw ?? '').trim()
	if (!s) return undefined
	const u = new URL(s)
	return u.toString().endsWith('/') ? u.toString() : `${u.toString()}/`
}

function buildPublicURL(base: string, key: string): string {
	const safePath = key
		.split('/')
		.filter(Boolean)
		.map((seg) => encodeURIComponent(seg))
		.join('/')
	return new URL(safePath, base).toString()
}
