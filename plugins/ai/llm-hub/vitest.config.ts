import { createRequire } from 'node:module'
import { mergeConfig } from 'vitest/config'

const require = createRequire(import.meta.url)

const base = require('@pluxel/test/vitest').default

// Force Node-compatible entrypoints for packages that ship a bundler-only "module" build.
const otelApiCjsEntry = require.resolve('@opentelemetry/api')

export default mergeConfig(base, {
	resolve: {
		alias: [{ find: '@opentelemetry/api', replacement: otelApiCjsEntry }],
	},
})
