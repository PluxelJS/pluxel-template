import { definePluxelVitestWorkspaceConfig } from '@pluxel/test/vitest'
import { resolve } from 'node:path'

export default definePluxelVitestWorkspaceConfig({
	roots: ['packages', 'plugins', 'builtin-plugins', 'render-plugins', 'chatbots', 'univer'],
	// This workspace consumes Pluxel packages via pnpm symlinks to a sibling repo (`../pluxel`).
	// Vitest/Vite will resolve those symlinks to real paths (outside this repo), so we must allow
	// file serving from that directory for `@pluxel/source`-conditioned imports to work.
	server: {
		fs: {
			allow: [resolve(process.cwd(), '../pluxel')],
		},
	},
	test: {
		// Keep memory bounded when running many projects in a single workspace.
		fileParallelism: false,
		minWorkers: 1,
		maxWorkers: 1,
		poolOptions: {
			threads: {
				minThreads: 1,
				maxThreads: 1,
				singleThread: true,
			},
		},
	},
})
