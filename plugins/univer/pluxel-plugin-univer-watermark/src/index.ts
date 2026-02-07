import { BasePlugin, Config, Plugin, type Config as PluxelConfig } from '@pluxel/hmr'
import { v } from '@pluxel/hmr/config'
import { UniverPlugin } from 'pluxel-plugin-univer'

export const UniverWatermarkConfigSchema = v.object({
	enabled: v.optional(v.boolean(), true),
	content: v.optional(v.string(), 'Pluxel × Univer'),
	fontSize: v.optional(v.number(), 36),
})

type UniverWatermarkConfig = PluxelConfig<typeof UniverWatermarkConfigSchema>

@Plugin({ name: 'UniverWatermark', type: 'service' })
export class UniverWatermarkPlugin extends BasePlugin {
	@Config(UniverWatermarkConfigSchema)
	private config!: UniverWatermarkConfig

	constructor(private readonly univer: UniverPlugin) {
		super()
	}

	override async init(_abort: AbortSignal): Promise<void> {
		if (!this.config.enabled) return

		this.univer.use({
			plugin: 'watermark',
			config: {
				textWatermarkSettings: { content: this.config.content, fontSize: this.config.fontSize },
			},
		})
	}
}

export default UniverWatermarkPlugin
