#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const productRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)))

function usage() {
	process.stdout.write(`Usage:
  node setup.mjs <command>

Commands:
  link        Create/refresh vendor symlinks.
  bootstrap   link + build pluxel dist + pnpm install.

Environment:
  PLUXEL_TEMPLATE_DIR  Path to a local pluxel-template repo.
  PLUXEL_DIR           Path to a local pluxel repo.
`)
}

function findTemplateDir() {
	const env = process.env.PLUXEL_TEMPLATE_DIR
	if (env) return path.resolve(env)

	let cur = productRoot
	for (let i = 0; i < 6; i++) {
		const cand = path.resolve(cur, '..', 'pluxel-template')
		if (fs.existsSync(path.join(cand, 'setup.mjs'))) return cand
		cur = path.resolve(cur, '..')
	}
	return null
}

function run(cmd) {
	const templateDir = findTemplateDir()
	if (!templateDir) {
		process.stderr.write('[setup] missing pluxel-template (set PLUXEL_TEMPLATE_DIR)\n')
		process.exit(2)
	}
	const setupPath = path.join(templateDir, 'setup.mjs')
	const res = spawnSync(process.execPath, [setupPath, cmd, productRoot], { stdio: 'inherit', cwd: productRoot })
	if (res.error) {
		process.stderr.write(`[setup] ${res.error.message}\n`)
		process.exit(2)
	}
	process.exit(res.status ?? 1)
}

const cmd = process.argv[2]
if (!cmd || cmd === '-h' || cmd === '--help') {
	usage()
	process.exit(0)
}

if (cmd === 'link' || cmd === 'bootstrap') run(cmd)
else {
	process.stderr.write(`[setup] unknown command: ${cmd}\n`)
	usage()
	process.exit(2)
}
