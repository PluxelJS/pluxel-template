import { createDevRunner } from './dev-runner.mjs'

const runner = createDevRunner({
	env: {
		PLUXEL_HMR_PROFILE: 'demos',
		PLUXEL_HMR_CONFIG: 'pluxel.hmr.demos.jsonc',
	},
})

// Keep builtin dist up-to-date (Turbo cached).
runner.runSync('node', ['scripts/predev.mjs'])

runner.run('host', 'node', ['--conditions=@pluxel/hmr', 'src/index.ts'])
