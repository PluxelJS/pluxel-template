import { spawn } from 'node:child_process'
import { spawnSync } from 'node:child_process'

const procs = []

function run(label, cmd, args, extraEnv = {}) {
	const child = spawn(cmd, args, {
		stdio: 'inherit',
		env: { ...process.env, ...extraEnv },
	})
	procs.push({ label, child })
	child.on('exit', (code, signal) => {
		if (signal) return
		if (typeof code === 'number' && code !== 0) {
			console.error(`[dev] ${label} exited with code ${code}`)
			shutdown(code)
		}
	})
	return child
}

let shuttingDown = false
function shutdown(code = 0) {
	if (shuttingDown) return
	shuttingDown = true
	for (const { child } of procs) {
		try {
			child.kill('SIGINT')
		} catch {}
	}
	setTimeout(() => process.exit(code), 250).unref()
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

const hmrProfile = process.env.PLUXEL_HMR_PROFILE ?? 'univer'

// `dev` has a lifecycle `predev`, but `dev:full` doesn't. Run it explicitly so builtins-from-dist
// listed in `pluxel.hmr.jsonc` are up-to-date (Turbo cached).
{
	const r = spawnSync('node', ['scripts/predev.mjs'], {
		stdio: 'inherit',
		env: { ...process.env, PLUXEL_HMR_PROFILE: hmrProfile },
	})
	if (r.error) throw r.error
	if (typeof r.status === 'number' && r.status !== 0) process.exit(r.status)
}

run('host', 'node', ['--conditions=@pluxel/hmr', 'src/index.ts'], { PLUXEL_HMR_PROFILE: hmrProfile })
run('univer-web', 'pnpm', ['--filter', 'pluxel-univer-web', 'dev'])
