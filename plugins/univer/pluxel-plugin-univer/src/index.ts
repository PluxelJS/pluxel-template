import { BasePlugin, Config, Plugin, type Config as PluxelConfig } from '@pluxel/hmr'
import { v } from '@pluxel/hmr/config'
import type {
	UniverConfiguredPlugin,
	UniverPluginSpec,
	UniverPluginsRemovePayload,
	UniverPluginsSnapshotPayload,
	UniverPluginsUpsertPayload,
} from '@pluxel/univer-protocol'
import { UNIVER_PLUGINS_SSE_NS } from '@pluxel/univer-protocol'

type PluginEvent = 'upsert' | 'remove'

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

	@Config(UniverConfigSchema)
	private config!: UniverConfig

	override async init(_abort: AbortSignal): Promise<void> {
		this.registerPluginsSse()
		this.applyBuiltinSpecs()
	}

	/**
	 * The only public entry: enable a Univer plugin (frontend-bundled) owned by the caller plugin.
	 *
	 * - Host/Service side only manages serializable specs + lifecycle.
	 * - If called from another plugin, auto-collected into `ctx.caller.effects`.
	 */
	public use(input: UniverConfiguredPlugin): () => void {
		const owner = this.ctx.caller?.pluginInfo?.id ?? 'core'
		const id = input.id ?? `${owner}:${input.plugin}`

		const spec: UniverPluginSpec = {
			id,
			kind: 'univer-plugin',
			plugin: input.plugin,
			config: input.config,
		}

		this.specs.set(id, spec)
		for (const push of this.ssePushers) {
			try {
				push('upsert', { plugin: spec } satisfies UniverPluginsUpsertPayload)
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
					plugin: 'watermark',
					config: { textWatermarkSettings: { content, fontSize: wm?.fontSize } },
				})
			}
		}
	}

	private snapshot(): UniverPluginsSnapshotPayload {
		return { plugins: [...this.specs.values()] }
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

export type { UniverConfiguredPlugin } from '@pluxel/univer-protocol'
