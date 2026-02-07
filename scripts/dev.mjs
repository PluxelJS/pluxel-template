import { spawn } from 'node:child_process'

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

// 1) Backend HMR host (serves /api/*)
run('host', 'node', ['src/index.ts'])

// 2) Univer frontend (proxies /api/* to the host)
run('univer-web', 'pnpm', ['--filter', 'pluxel-univer-web', 'dev'])
