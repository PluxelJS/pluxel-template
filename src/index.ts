import { startHmrHost } from '@pluxel/hmr/host'
import Macro from 'unplugin-macros/vite'
import { partsTransformVitePlugin } from 'pluxel-plugin-bot-core/parts/rolldown'

// Builtin plugins are configured in `pluxel.hmr.jsonc` (profile.builtin) and loaded from dist (.mjs).
const { ctx } = await startHmrHost({
	debug: ['pluxel:hmr:*'],
	// Keep runtime state out of git-tracked `data/`.
	store: {
		seedConfig: 'default.json',
	},
	vitePlugins: [Macro() as any, partsTransformVitePlugin()],
	cjsExternal: ['pluxel-plugin-napi-rs/*', '@napi-rs/*', '@memecrafters/meme-generator'],
	registry: {},
})

ctx.logger.info`HMR host ready`
