import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { definePluxelVitestWorkspaceConfig } = require('@pluxel/test/vitest') as {
	definePluxelVitestWorkspaceConfig: (cfg: unknown) => unknown
}

function collectPluginRoots(): string[] {
	const cwd = fileURLToPath(new URL('.', import.meta.url))
	const pluginsDir = join(cwd, 'plugins')

	try {
		return readdirSync(pluginsDir, { withFileTypes: true })
			.filter((e) => e.isDirectory() && !e.name.startsWith('.'))
			.map((e) => `plugins/${e.name}`)
	} catch {
		return []
	}
}

export default definePluxelVitestWorkspaceConfig({
	roots: ['packages', 'apps', ...collectPluginRoots()],
})
