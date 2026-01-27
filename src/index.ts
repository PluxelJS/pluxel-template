import GraphQL from '@pluxel/graphql'
import { startHmrHost } from '@pluxel/hmr/host'
import { LogtapeLoggerService } from '@pluxel/hmr/services'
import Wretch from '@pluxel/wretch'
import Macro from 'unplugin-macros/vite'
import { partsTransformVitePlugin } from 'pluxel-plugin-bot-core/parts/rolldown'

const { ctx } = await startHmrHost({
	debug: ['pluxel:hmr:*'],
	// Keep runtime state out of git-tracked `data/`.
	store: {
		seedConfig: 'default.json',
	},
	builtins: [GraphQL, Wretch],
	vitePlugins: [Macro() as any, partsTransformVitePlugin()],
	// If the host imports builtins from compiled `dist/` (Node), but the runner would resolve `@pluxel/hmr`
	// to TS sources, we must bridge them so DI tokens (ctors) match across host/runner.
	deps: { bridgeModules: ['@pluxel/graphql', '@pluxel/wretch'] },
	cjsExternal: ['pluxel-plugin-napi-rs/*', '@napi-rs/*', '@memecrafters/meme-generator'],
	registry: {
		pluginCTXIsolate: [LogtapeLoggerService],
	},
})

ctx.logger.info`HMR host ready`
