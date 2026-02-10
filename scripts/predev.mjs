import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	getHmrProfileBuiltinPackages,
	readHmrProfileView,
	resolveHmrWorkspaceSnapshot,
} from '@pluxel/cli/hmr'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const configPath = process.env.PLUXEL_HMR_CONFIG
	? resolve(repoRoot, process.env.PLUXEL_HMR_CONFIG)
	: undefined

function run(cmd, args) {
	const result = spawnSync(cmd, args, { stdio: 'inherit' })
	if (result.error) throw result.error
	if (typeof result.status === 'number' && result.status !== 0) process.exit(result.status)
}

function uniqStrings(values) {
	return [...new Set(values)].filter((value) => typeof value === 'string' && value.length > 0)
}

const hmrRef = {
	rootDir: repoRoot,
	configPath,
	profile: process.env.PLUXEL_HMR_PROFILE,
	env: process.env,
}

const profileView = readHmrProfileView(hmrRef)
const builtinPackages = uniqStrings(getHmrProfileBuiltinPackages(hmrRef))

let packagesToBuild = builtinPackages

if (builtinPackages.length > 0) {
	try {
		const snapshot = await resolveHmrWorkspaceSnapshot(hmrRef)
		const builtinsFromDist = snapshot.builtinsFromDist?.map((item) => item.packageName) ?? []
		if (builtinsFromDist.length > 0) {
			packagesToBuild = uniqStrings(builtinsFromDist)
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		console.warn(
			`[predev] Failed to resolve workspace snapshot for profile "${profileView.activeProfile}".`,
		)
		console.warn(`[predev] ${message}`)
	}
}

if (packagesToBuild.length > 0) {
	run('pnpm', ['-s', 'turbo', 'build:builtin', ...packagesToBuild.flatMap((name) => ['--filter', name])])
}
