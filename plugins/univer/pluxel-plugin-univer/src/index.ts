import { BasePlugin, Config, Plugin, type Config as PluxelConfig } from '@pluxel/hmr'
import { v } from '@pluxel/hmr/config'
import { RpcTarget } from '@pluxel/hmr/capnweb'
import type {
	UniverPluginRegistration,
	UniverCapabilitiesSnapshot,
	UniverCapabilityResult,
	UniverPluginSpec,
	UniverPluginsRemovePayload,
	UniverPluginsSnapshotPayload,
	UniverPluginsUpsertPayload,
} from '@pluxel/univer-headless/protocol'
import { UNIVER_PLUGINS_SSE_NS } from '@pluxel/univer-headless/protocol'

type PluginEvent = 'upsert' | 'remove'

export type CapabilityProvider = () => unknown | Promise<unknown>

export class UniverRpc extends RpcTarget {
	constructor(private readonly plugin: UniverPlugin) {
		super()
	}

	capabilities(): Promise<UniverCapabilitiesSnapshot> {
		return this.plugin.capabilitiesSnapshot()
	}
}

export const UniverConfigSchema = v.object({
	watermark: v.optional(
		v.object({
			enabled: v.optional(v.boolean(), true),
			content: v.optional(v.string(), 'Pluxel × Univer'),
			fontSize: v.optional(v.number(), 36),
		}),
		{},
	),
})

export type UniverConfig = PluxelConfig<typeof UniverConfigSchema>

@Plugin({ name: 'Univer', type: 'service' })
export class UniverPlugin extends BasePlugin {
	private readonly specs = new Map<string, UniverPluginSpec>()
	private readonly ssePushers = new Set<(event: PluginEvent, payload: unknown) => void>()
	private readonly capabilityProviders = new Map<string, CapabilityProvider>()
	private capabilitiesCache: UniverCapabilitiesSnapshot | null = null
	private capabilitiesInFlight: Promise<UniverCapabilitiesSnapshot> | null = null
	private readonly capabilitiesTtlMs = 2_000

	private config = this.configs.use(UniverConfigSchema)

	override async init(_abort: AbortSignal): Promise<void> {
		this.registerPluginsSse()
		this.registerRpc()
		this.applyBuiltinSpecs()
	}

	/**
	 * Register a capability provider under a stable key.
	 *
	 * This is a lightweight "contract surface" for other plugins. The core service owns
	 * the RPC; feature plugins only provide values.
	 */
	public provideCapability(key: string, provider: CapabilityProvider): () => void {
		const k = String(key ?? '').trim()
		if (!k) throw new Error('[univer] capability key must be non-empty')
		this.capabilityProviders.set(k, provider)
		this.invalidateCapabilities()

		const dispose = () => {
			const cur = this.capabilityProviders.get(k)
			if (cur !== provider) return
			this.capabilityProviders.delete(k)
			this.invalidateCapabilities()
		}

		const effects = this.ctx.caller?.effects ?? this.ctx.effects
		const guard = effects.defer(dispose)
		return () => guard.dispose()
	}

	private invalidateCapabilities() {
		this.capabilitiesCache = null
	}

	private async computeCapabilities(): Promise<UniverCapabilitiesSnapshot> {
		const providers = [...this.capabilityProviders.entries()]
		const results = await Promise.all(
			providers.map(async ([key, provider]) => {
				try {
					const value = await provider()
					return [key, { ok: true, value } satisfies UniverCapabilityResult] as const
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e)
					return [key, { ok: false, error: msg } satisfies UniverCapabilityResult] as const
				}
			}),
		)
		return { at: Date.now(), items: Object.fromEntries(results) }
	}

	public async capabilitiesSnapshot(): Promise<UniverCapabilitiesSnapshot> {
		const cur = this.capabilitiesCache
		if (cur && Date.now() - cur.at < this.capabilitiesTtlMs) return cur
		if (this.capabilitiesInFlight) return this.capabilitiesInFlight
		this.capabilitiesInFlight = this.computeCapabilities().finally(() => {
			this.capabilitiesInFlight = null
		})
		const snap = await this.capabilitiesInFlight
		this.capabilitiesCache = snap
		return snap
	}

	/**
	 * The only public entry: enable a Univer plugin (frontend-bundled) owned by the caller plugin.
	 *
	 * - Host/Service side only manages serializable specs + lifecycle.
	 * - If called from another plugin, auto-collected into `ctx.caller.effects`.
	 */
	public use(input: UniverPluginRegistration): () => void {
		const owner = this.ctx.caller?.pluginInfo?.id ?? 'core'
		const id = input.id ?? `${owner}:${input.key}`

		const spec: UniverPluginSpec = {
			id,
			key: input.key,
			config: input.config,
		}

		this.specs.set(id, spec)
		for (const push of this.ssePushers) {
			try {
				push('upsert', { item: spec } satisfies UniverPluginsUpsertPayload)
			} catch (error) {
				this.ctx.logger.warn('Univer plugin SSE push failed', { error })
			}
		}

		const dispose = () => {
			const cur = this.specs.get(id)
			if (cur !== spec) return
			this.specs.delete(id)
			for (const push of this.ssePushers) {
				try {
					push('remove', { id } satisfies UniverPluginsRemovePayload)
				} catch (error) {
					this.ctx.logger.warn('Univer plugin SSE push failed', { error })
				}
			}
		}

		const effects = this.ctx.caller?.effects ?? this.ctx.effects
		const guard = effects.defer(dispose)
		return () => guard.dispose()
	}

	private applyBuiltinSpecs() {
		const wm = this.config.watermark
		if (wm?.enabled !== false) {
			const content = typeof wm?.content === 'string' ? wm.content.trim() : ''
			if (content) {
				this.use({
					id: 'univer:watermark',
					key: 'watermark',
					config: { textWatermarkSettings: { content, fontSize: wm?.fontSize } },
				})
			}
		}
	}

	private snapshot(): UniverPluginsSnapshotPayload {
		return { items: [...this.specs.values()] }
	}

	private registerRpc() {
		try {
			this.ctx.ext.rpc.registerExtension(() => new UniverRpc(this))
		} catch (error) {
			// Allow running in minimal/test hosts without ext.rpc.
			this.ctx.logger.warn('Univer RPC registration skipped', { error })
		}
	}

	private registerPluginsSse() {
		try {
			this.ctx.ext.sse.registerExtension(
				() => async (channel) => {
					channel.emit('snapshot', this.snapshot())
					const push = (event: PluginEvent, payload: unknown) => channel.emit(event, payload)
					this.ssePushers.add(push)
					return () => {
						this.ssePushers.delete(push)
					}
				},
				{ namespace: UNIVER_PLUGINS_SSE_NS },
			)
		} catch (error) {
			// Allow running in minimal/test hosts without ext.sse.
			this.ctx.logger.warn('Univer SSE registration skipped', { error })
		}
	}
}

export default UniverPlugin

export type { UniverPluginRegistration } from '@pluxel/univer-headless/protocol'

declare module '@pluxel/hmr/services' {
	namespace UI {
		interface rpc {
			Univer: UniverRpc
		}
	}
}
