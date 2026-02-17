import { createHmrHost } from '@pluxel/hmr/host'
import Macro from 'unplugin-macros/vite'

const { ctx } = await createHmrHost({
	debug: ['pluxel:hmr:*'],
	profile: process.env.PLUXEL_HMR_PROFILE,
	configPath: process.env.PLUXEL_HMR_CONFIG ?? 'pluxel.hmr.jsonc',
	store: {
		seedConfig: 'default.json',
	},
	vitePlugins: [Macro() as any],
	cjsExternal: ['pluxel-plugin-napi-rs/*', '@napi-rs/*'],
	registry: {},
})

await ctx.root.hmrService.start()

ctx.logger.info`HMR host ready`

