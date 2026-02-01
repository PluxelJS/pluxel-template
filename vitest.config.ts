import { definePluxelVitestWorkspaceConfig } from '@pluxel/test/vitest'

export default definePluxelVitestWorkspaceConfig({
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
