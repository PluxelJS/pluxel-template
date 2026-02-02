import { BasePlugin, Plugin } from '@pluxel/hmr'
import { f, v } from '@pluxel/hmr/config'

import { UniverSheetsHub } from 'pluxel-plugin-univer-sheets'

const WatermarkSettingsSchema = v.object({
	enabled: v.pipe(
		v.optional(v.boolean(), true),
		f.formMeta({ label: '启用水印' }),
		f.booleanMeta({}),
	),
	content: v.pipe(
		v.optional(v.string(), 'Pluxel × Univer（水印来自配置）'),
		v.minLength(1),
		f.formMeta({ label: '内容' }),
		f.stringMeta({ control: 'text' }),
	),
	fontSize: v.pipe(
		v.optional(v.number(), 28),
		f.formMeta({ label: '字号' }),
		f.numberMeta({ min: 8, max: 120, step: 1 }),
	),
	rotate: v.pipe(
		v.optional(v.number(), -15),
		f.formMeta({ label: '旋转角度 (deg)' }),
		f.numberMeta({ min: -90, max: 90, step: 1 }),
	),
	opacity: v.pipe(
		v.optional(v.number(), 0.2),
		f.formMeta({ label: '透明度', description: '0 ~ 1' }),
		f.numberMeta({ min: 0, max: 1, step: 0.01 }),
	),
	repeat: v.pipe(
		v.optional(v.boolean(), true),
		f.formMeta({ label: '重复铺满' }),
		f.booleanMeta({}),
	),
	color: v.pipe(
		v.optional(v.string(), 'rgba(120, 120, 120, 0.28)'),
		v.minLength(1),
		f.formMeta({ label: '颜色', description: '任意合法 CSS color 字符串' }),
		f.stringMeta({ control: 'text' }),
	),
})

type WatermarkSettings = v.InferOutput<typeof WatermarkSettingsSchema>

@Plugin({ name: 'UniverWatermarkDemo' })
export class UniverWatermarkDemo extends BasePlugin {
	watermark = this.configs.use(WatermarkSettingsSchema)

	override init() {
		this.features.dep(UniverSheetsHub, (hub) => {
			const pluginName = this.ctx.pluginInfo.id
			const dispose = hub.registerContributionProvider(
				{
					id: 'demo',
					contribution: () => {
						const cfg = this.watermark as WatermarkSettings
						if (!cfg.enabled) return null

						return {
							type: 'watermark:text',
							priority: 10,
							settings: {
								content: cfg.content,
								fontSize: cfg.fontSize,
								color: cfg.color,
								repeat: cfg.repeat,
								opacity: cfg.opacity,
								rotate: cfg.rotate,
							},
						}
					},
				},
				{ sourcePlugin: pluginName },
			)
			this.ctx.logger.info('registered watermark contribution provider (config-driven)')
			return () => dispose()
		})
	}
}

export default UniverWatermarkDemo
export const plugins = [UniverWatermarkDemo] as const
