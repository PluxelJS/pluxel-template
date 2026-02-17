import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

function run(cmd, args) {
	const result = spawnSync(cmd, args, { stdio: 'inherit' })
	if (result.error) throw result.error
	if (typeof result.status === 'number' && result.status !== 0) process.exit(result.status)
}

function check(condition, message) {
	if (!condition) {
		console.error(`[doctor] ${message}`)
		process.exit(2)
	}
}

// 1) HMR config sanity (source of many “looks ok but wrong” issues).
run('pnpm', ['-s', 'exec', 'pluxel', 'hmr', 'doctor'])

// 2) Guardrails for this repo: product folders must not be part of this upstream workspace.
// (Downstreams may still have those folders in their own repos.)
const workspaceYaml = readFileSync('pnpm-workspace.yaml', 'utf8')
check(
	workspaceYaml.includes("!plugins/chatbots/**") && workspaceYaml.includes("!plugins/univer/**"),
	'pnpm-workspace.yaml should exclude product folders: "!plugins/chatbots/**" and "!plugins/univer/**".',
)

console.log('[doctor] ok')
