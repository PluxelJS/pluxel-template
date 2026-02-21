import { definePluxelVitestConfig } from '@pluxel/test/vitest'

// This package lives outside the core monorepo's default `packages/**` globs.
// Enable Pluxel toolchain extraction for local `src/**` so `configs.use(...)` is injected in tests.
export default definePluxelVitestConfig({}, { include: ['src/**/*.ts'] })
