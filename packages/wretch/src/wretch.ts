import { BasePlugin, Config, Plugin } from '@pluxel/hmr'
import { v } from '@pluxel/hmr/config'
import wretch, { type Wretch } from 'wretch'
import AbortAddon from 'wretch/addons/abort'

export type { WretchError } from 'wretch'
export type HttpClient = Wretch
export { default as AbortAddon } from 'wretch/addons/abort'
export * as middlewares from 'wretch/middlewares'

interface ClientConfig {
	timeout: number
	throwHttpErrors: boolean
}

export interface ClientOverrides {
	baseUrl?: string
	prefixUrl?: string
	headers?: Record<string, string>
	timeout?: number
	throwHttpErrors?: boolean
}

const CoreCfg = v.object({
	baseURL: v.optional(v.string(), ''),
	timeout: v.optional(v.number(), 10_000),
})

const HeadersCfg = v.object({
	headers: v.optional(v.record(v.string(), v.string()), {
		accept: 'application/json',
		'user-agent': 'pluxel-http/1',
	}),
})

const ProxyCfg = v.object({
	enabled: v.optional(v.boolean(), false),
	url: v.optional(v.string()),
	applyGlobalDispatcher: v.optional(v.boolean(), true),
})

@Plugin({ name: 'Wretch', type: 'service' })
export class WretchPlugin extends BasePlugin {
	@Config(CoreCfg) private core!: v.InferOutput<typeof CoreCfg>
	@Config(HeadersCfg) private header!: v.InferOutput<typeof HeadersCfg>
	@Config(ProxyCfg) private proxy!: v.InferOutput<typeof ProxyCfg>

	public client!: HttpClient

	private base!: Wretch
	private defaults!: ClientConfig

	private _prevDispatcher: unknown | undefined
	private _appliedGlobal = false

	async init(_abort: AbortSignal): Promise<void> {
		const isNode = typeof process !== 'undefined' && !!(process as any).versions?.node

		if (isNode && this.proxy.enabled) {
			try {
				// @ts-expect-error Optional runtime dependency in Node environments
				const undici = (await import('undici')) as any
				const { ProxyAgent, Agent, getGlobalDispatcher, setGlobalDispatcher } = undici

				const dispatcher = this.proxy.url
					? new ProxyAgent({ uri: this.proxy.url })
					: new Agent({ keepAlive: true })

				if (this.proxy.applyGlobalDispatcher) {
					this._prevDispatcher = getGlobalDispatcher?.()
					setGlobalDispatcher?.(dispatcher)
					this._appliedGlobal = true
					this.ctx.logger.info('HTTP: global dispatcher applied')
				} else {
					this.ctx.logger.info('HTTP: dispatcher created (not global)')
				}
			} catch (e) {
				this.ctx.logger.warn('HTTP: undici unavailable, skip proxy', e)
			}
		}

		const baseHeaders = this.header.headers ?? {}
		let base = wretch(this.core.baseURL || '').addon(AbortAddon())
		if (Object.keys(baseHeaders).length > 0) {
			base = base.headers(baseHeaders)
		}

		this.base = base as any
		this.defaults = {
			timeout: this.core.timeout,
			throwHttpErrors: this.core.throwHttpErrors,
		}
		this.client = this.buildClient()

		this.ctx.logger.info('WretchPlugin initialized')
	}

	async stop(_abort: AbortSignal): Promise<void> {
		if (this._appliedGlobal) {
			try {
				// @ts-expect-error Optional runtime dependency in Node environments
				const undici = (await import('undici')) as any
				undici.setGlobalDispatcher?.(this._prevDispatcher ?? undici.getGlobalDispatcher?.())
				this.ctx.logger.info('HTTP: global dispatcher restored')
			} catch {}
		}
	}

	createClient(overrides: ClientOverrides = {}): HttpClient {
		return this.buildClient(overrides)
	}

	private buildClient(overrides: ClientOverrides = {}): HttpClient {
		const config = this.mergeConfig(overrides)

		let client = this.base
		if (overrides.baseUrl) {
			client = client.url(overrides.baseUrl, true)
		}
		if (overrides.prefixUrl) {
			client = client.url(overrides.prefixUrl)
		}
		if (overrides.headers) {
			client = client.headers(overrides.headers)
		}

		if (Number.isFinite(config.timeout) && config.timeout > 0) {
			client = client.resolve((chain) => {
				const maybeAbort = chain as unknown as { setTimeout?: (ms: number) => void }
				if (typeof maybeAbort.setTimeout === 'function') {
					maybeAbort.setTimeout(config.timeout)
				}
				return chain
			}) as any
		}

		return client
	}

	private mergeConfig(overrides: ClientOverrides): ClientConfig {
		return {
			timeout: overrides.timeout ?? this.defaults.timeout,
			throwHttpErrors: overrides.throwHttpErrors ?? this.defaults.throwHttpErrors,
		}
	}
}
