import { definePluxelVitestWorkspaceConfig } from '@pluxel/test/vitest'
import { VITEST_WORKSPACE_ROOTS } from './scripts/vitest-workspace-roots.mjs'
export default definePluxelVitestWorkspaceConfig({
	roots: VITEST_WORKSPACE_ROOTS,
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
