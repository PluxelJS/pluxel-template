import { spawn, spawnSync } from 'node:child_process'

export function createDevRunner({ labelPrefix = 'dev', env: baseEnv = {} } = {}) {
	const procs = []
	let shuttingDown = false

	function run(label, cmd, args, extraEnv = {}) {
		const child = spawn(cmd, args, {
			stdio: 'inherit',
			env: { ...process.env, ...baseEnv, ...extraEnv },
		})
		procs.push({ label, child })
		child.on('exit', (code, signal) => {
			if (signal) return
			if (typeof code === 'number' && code !== 0) {
				console.error(`[${labelPrefix}] ${label} exited with code ${code}`)
				shutdown(code)
			}
		})
		return child
	}

	function runSync(cmd, args, extraEnv = {}) {
		const result = spawnSync(cmd, args, {
			stdio: 'inherit',
			env: { ...process.env, ...baseEnv, ...extraEnv },
		})
		if (result.error) throw result.error
		if (typeof result.status === 'number' && result.status !== 0) process.exit(result.status)
		return result
	}

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

	return { run, runSync, shutdown }
}
