import { BasePlugin, Config, Plugin } from '@pluxel/hmr'
import { v, f } from '@pluxel/hmr/config'
// PluginA.ts
// PluginA 依赖 PluginB 为必选依赖，依赖 PluginC 为可选依赖
// biome-ignore lint/style/useImportType: <PluginSystem>
import { PluginB } from './PluginB'
// biome-ignore lint/style/useImportType: <PluginSystem>
import { PluginC } from './PluginC'

const test = v.object({
		id: v.pipe(
			v.number(),
			
					f.numberMeta({
						type: 'slider',
						options: {
							min: 0,
							max: 100,
							step: 5,
							marks: [
								{ value: 0, label: '0' },
								{ value: 5, label: '5' },
								{ value: 10, label: '10' },
							],
						},
					}),
					v.maxValue(10),
		),
		name: v.optional(v.pipe(v.string(), v.hexColor()), '#000000'),
		check: v.optional(v.boolean(), true),
	})
@Plugin({ name: 'PluginA' })
export class PluginA extends BasePlugin {
	@Config(test)
	private config!: Config<typeof test>;

	constructor(public pluginB: PluginB) {
    super();
  }

	init(_abort: AbortSignal) {
		this.ctx.logger.info('PluginA initialized')
		// 使用必需依赖 PluginB
		this.pluginB.doSomething()
		this.ctx.honoService.modifyApp((app) => {
			app.get("/a", (c) => { return c.html("text")})
		})
	}

	stop(abort: AbortSignal) {
		
	}
	doSomething(): void {
		this.ctx.logger.info('PluginA doing something...')
	}
}
