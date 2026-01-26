import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context } from '@pluxel/hmr'
import { LogtapeLoggerService } from '@pluxel/hmr/services'
import { GraphQLPlugin } from '@pluxel/graphql'
import Macro from "unplugin-macros/vite"
import { partsTransformVitePlugin } from 'pluxel-plugin-bot-core/parts/rolldown'
import { WretchPlugin } from '@pluxel/wretch'

if (process.env.PLUXEL_HMR_SSR === undefined) process.env.PLUXEL_HMR_SSR = 'true'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const logsDir = join(root, 'logs')
await mkdir(logsDir, { recursive: true })

const ctx = new Context({
	debug: ['pluxel:hmr:*'],
	hmrService: {
		// Scan workspace plugin entrypoints (chatbots, render-plugins, etc).
		// Builtin plugins are loaded via `builtins` to avoid relying on scanning.
		dir: [join(root, 'chatbots'), join(root, 'render-plugins'), join(root, 'plugins'), join(root, '.') ],
		coldStart: 'background',
		builtins: [GraphQLPlugin, WretchPlugin],
		vitePlugins: [Macro() as any, partsTransformVitePlugin()],
		deps: {
			cjsExternal: ['pluxel-plugin-napi-rs/*', '@napi-rs/*', '@memecrafters/meme-generator'],
		},
		log: {
			// HMR defaults will auto-configure LogTape on first `hmr.start()` if the host didn't call `configure()`.
			logtape: { file: join(logsDir, 'hmr.log') },
		},
	},
	registry: {
		pluginCTXIsolate: [LogtapeLoggerService],
	},
})

await ctx.hmrService.start()
ctx.logger.info`HMR host ready`
