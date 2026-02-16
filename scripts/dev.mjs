import { createDevRunner } from './dev-runner.mjs'

const runner = createDevRunner()

// Backend HMR host only (serves /api/*).
runner.run('host', 'node', ['--conditions=@pluxel/hmr', 'src/index.ts'])
