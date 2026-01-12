import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context } from '@pluxel/hmr'
import { LogtapeLoggerService } from '@pluxel/hmr/services'
import Macro from "unplugin-macros/vite"
import { partsTransformVitePlugin } from "@pluxel/bot-layer/parts/rolldown"

const logsDir = join(dirname(fileURLToPath(import.meta.url)), './logs')
await mkdir(logsDir, { recursive: true })

const ctx = new Context({
	debug: ['pluxel:hmr:*'],
	hmrService: {
		dir: ['./src/ui-plugins', '.'],
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
ctx.honoService.modifyApp((app) => {
	app.get('/pluginadd', (c) => c.text('lastone'))
})
