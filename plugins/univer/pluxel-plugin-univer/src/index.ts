import { BasePlugin, Config, Plugin, type Config as PluxelConfig } from '@pluxel/hmr'
import { v } from '@pluxel/hmr/config'

import { registerUniverExtensions } from './extensions'

import type {
	UniverConfiguredPlugin,
	UniverPluginSpec,
	UniverPluginsRemovePayload,
	UniverPluginsSnapshotPayload,
	UniverPluginsUpsertPayload,
} from './shared'
import { UNIVER_PLUGINS_SSE_NS } from './shared'

export const UniverCoreConfigSchema = v.object({
	watermark: v.object({
		enabled: v.optional(v.boolean(), true),
		content: v.optional(v.string(), 'Pluxel × Univer'),
		fontSize: v.optional(v.number(), 36),
	}),
})

type UniverCoreConfig = PluxelConfig<typeof UniverCoreConfigSchema>

type PluginEvent = 'upsert' | 'remove'

@Plugin({ name: 'Univer', type: 'service' })
export class UniverPlugin extends BasePlugin {
	@Config(UniverCoreConfigSchema)
	private config!: UniverCoreConfig

	private readonly specs = new Map<string, UniverPluginSpec>()
	private readonly ssePushers = new Set<(event: PluginEvent, payload: unknown) => void>()

	override async init(_abort: AbortSignal): Promise<void> {
		registerUniverExtensions(this.ctx)
		this.registerPluginsSse()

		// Built-in: watermark from core config (optional).
		const wm = this.config.watermark
		if (wm.enabled) {
			this.use({
				id: 'watermark',
				plugin: 'watermark',
				config: {
					textWatermarkSettings: { content: wm.content, fontSize: wm.fontSize },
				},
			})
		}
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

export type { UniverConfiguredPlugin } from './shared'
