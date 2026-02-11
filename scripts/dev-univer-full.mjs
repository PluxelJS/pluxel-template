import { createDevRunner } from './dev-runner.mjs'

const hmrProfile = process.env.PLUXEL_HMR_PROFILE ?? 'univer'
const runner = createDevRunner({ env: { PLUXEL_HMR_PROFILE: hmrProfile } })

// `dev:full` does not have a lifecycle `predev`, run it explicitly so builtins-from-dist
// listed in `pluxel.hmr.jsonc` are up-to-date (Turbo cached).
runner.runSync('node', ['scripts/predev.mjs'])

runner.run('host', 'node', ['--conditions=@pluxel/hmr', 'src/index.ts'])
runner.run('univer-web', 'pnpm', ['--filter', 'pluxel-univer-web', 'dev'])
