import { createDevRunner } from './dev-runner.mjs'

const runner = createDevRunner()

// Backend HMR host only (serves /api/*).
//
// Univer frontend is an independent Vite app:
// - Start it separately when needed: `pnpm --filter pluxel-univer-web dev`
// - Or use `pnpm dev:univer` to run host + frontend together
runner.run('host', 'node', ['--conditions=@pluxel/hmr', 'src/index.ts'])
