import { spawn } from 'node:child_process'
import { collectPluxelVitestWorkspaceProjects } from '@pluxel/test/vitest'
import { VITEST_WORKSPACE_ROOTS } from './vitest-workspace-roots.mjs'

function shouldDropLine(line) {
	return (
		line.includes('[vite] warning: `esbuild` option was specified by "vitest') &&
		line.includes('deprecated, please use `oxc` instead')
	)
}

function pipeFiltered(input, output) {
	input.setEncoding('utf8')
	let buf = ''

	input.on('data', (chunk) => {
		buf += chunk
		const parts = buf.split(/\r?\n/)
		buf = parts.pop() ?? ''
		for (const line of parts) {
			if (!shouldDropLine(line)) output.write(`${line}\n`)
		}
	})

	input.on('end', () => {
		if (buf && !shouldDropLine(buf)) output.write(buf)
	})
}

function run(cmd, args) {
	const bin = process.platform === 'win32' ? `${cmd}.cmd` : cmd
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, { stdio: ['inherit', 'pipe', 'pipe'] })

		if (child.stdout) pipeFiltered(child.stdout, process.stdout)
		if (child.stderr) pipeFiltered(child.stderr, process.stderr)

		child.on('error', (err) => reject(err))
		child.on('close', (code) => resolve(code ?? 1))
	})
}

// Vitest multi-project mode is convenient but can OOM in large workspaces due to
// accumulating per-project Vite caches. Run one project per process instead.
const projects = collectPluxelVitestWorkspaceProjects({ roots: VITEST_WORKSPACE_ROOTS }).map((p) => p.name)
projects.sort()

for (const name of projects) {
	console.log(`\n=== vitest project: ${name} ===\n`)
	const code = await run('pnpm', ['exec', 'vitest', 'run', '-c', 'vitest.config.ts', '--project', name])
	if (code !== 0) process.exit(code)
}
