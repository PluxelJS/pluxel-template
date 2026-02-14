import { createHmrHost } from '@pluxel/hmr/host'
import Macro from 'unplugin-macros/vite'
import { partsTransformVitePlugin } from 'pluxel-plugin-bot-core/parts/rolldown'

// Builtin plugins are configured in `pluxel.hmr.jsonc` (profile.builtin) and loaded from dist (.mjs).
const { ctx } = await createHmrHost({
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

// Seed "univer" profile defaults once (do not keep forcing on every boot).
await ctx.root.configService.ready
if (ctx.config.hmrProfile === 'univer') {
	// Minimal, stable defaults for Univer development profile.
	//
	// Note: some local workspaces may already have a persisted config file with an old "seeded" extra,
	// but missing critical Univer AI plugins (e.g. UniverLoopback), which results in `/api/univer/loopback/run`
	// returning plain "404 Not Found" and the frontend failing to JSON.parse it.
	//
	// Only auto-repair when the user has AI enabled in this profile.
	const cs = ctx.root.configService
	const wantsAi = cs.isEnabledInConfig('UniverAI') || cs.isEnabledInConfig('UniverLoopback')
	if (wantsAi) {
		const required = ['Univer', 'UniverWorkbooks', 'UniverAI', 'UniverLoopback', 'LLMHub'] as const
		const missing = required.filter((name) => !cs.isEnabledInConfig(name))
		if (missing.length) {
			cs.batch(() => {
				cs.enableInConfig(...missing)
				cs.setExtra('univer.seeded.loopback.v2', true)
			})
		}
	}
}

await ctx.root.hmrService.start()

ctx.logger.info`HMR host ready`
