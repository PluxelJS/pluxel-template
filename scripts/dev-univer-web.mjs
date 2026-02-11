import { createDevRunner } from './dev-runner.mjs'

const runner = createDevRunner()

runner.run('univer-web', 'pnpm', ['--filter', 'pluxel-univer-web', 'dev'])
