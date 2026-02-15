import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { definePluxelVitestConfig } = require('@pluxel/test/vitest') as {
	definePluxelVitestConfig: (cfg: unknown, toolchain: unknown) => unknown
}

export default definePluxelVitestConfig(
	{},
	{ include: ['src/**/*.ts', 'tests/**/*.ts'] },
)
