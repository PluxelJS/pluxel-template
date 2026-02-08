import { startHmrHost } from '@pluxel/hmr/host'
import Macro from 'unplugin-macros/vite'
import { partsTransformVitePlugin } from 'pluxel-plugin-bot-core/parts/rolldown'

// Builtin plugins are configured in `pluxel.hmr.jsonc` (profile.builtin) and loaded from dist (.mjs).
const { ctx } = await startHmrHost({
	debug: ['pluxel:hmr:*'],
	profile: process.env.PLUXEL_HMR_PROFILE,
	configPath: process.env.PLUXEL_HMR_CONFIG,
	// Keep runtime state out of git-tracked `data/`.
	store: {
		seedConfig: 'default.json',
	},
	vitePlugins: [Macro() as any, partsTransformVitePlugin()],
	deps: {
		// `@gqloom/core` advertises a `"source"` export condition but does not publish `src/*`.
		// HMR runner enables `"source"` globally for workspace packages, which makes `@gqloom/core`
		// unresolvable when evaluated via Vite's SSR pipeline. Externalize it so Node resolves
		// the normal `"import"` entry instead.
		ssrExternal: ['@gqloom/core'],
	},
	cjsExternal: ['pluxel-plugin-napi-rs/*', '@napi-rs/*', '@memecrafters/meme-generator'],
	registry: {},
})

ctx.logger.info`HMR host ready`
