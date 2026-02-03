import GraphQL from '@pluxel/graphql'
import { startHmrHost } from '@pluxel/hmr/host'
import { LogtapeLoggerService } from '@pluxel/hmr/services'
import WebSocket from '@pluxel/websocket'
import Wretch from '@pluxel/wretch'
import Macro from 'unplugin-macros/vite'
import { partsTransformVitePlugin } from 'pluxel-plugin-bot-core/parts/rolldown'

const { ctx } = await startHmrHost({
	debug: ['pluxel:hmr:*'],
	// Keep runtime state out of git-tracked `data/`.
	store: {
		seedConfig: 'default.json',
	},
	// NOTE: provide moduleId so the host can automatically dedupe workspace-profile startup entries
	// that point at the same builtin plugin sources (prevents "plugin name conflict").
	builtins: [
		{ plugin: GraphQL, moduleId: '@pluxel/graphql', exportKey: 'default' },
		{ plugin: Wretch, moduleId: '@pluxel/wretch', exportKey: 'default' },
		{ plugin: WebSocket, moduleId: '@pluxel/websocket', exportKey: 'default' },
	],
	vitePlugins: [Macro() as any, partsTransformVitePlugin()],
	// Builtins are already compiled for Node, so keep the runner on the same dist entry to avoid ctor drift.
	deps: { ssrExternal: ['@pluxel/graphql', '@pluxel/wretch', '@pluxel/websocket'] },
	cjsExternal: ['pluxel-plugin-napi-rs/*', '@napi-rs/*', '@memecrafters/meme-generator'],
	registry: {
	},
})

ctx.logger.info`HMR host ready`
