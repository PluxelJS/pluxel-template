#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const templateRoot = path.dirname(fileURLToPath(import.meta.url))
const scaffoldRoot = path.join(templateRoot, 'scaffold', 'downstream')

function usage() {
	process.stdout.write(`Usage:
  node setup.mjs <command> [dir] [options]

Commands:
  link [product_dir]         Create/refresh vendor symlinks in product_dir (default: cwd).
  bootstrap [product_dir]    link + build pluxel dist + pnpm install (default: cwd).
  init <product_dir>         Scaffold a downstream repo, then (optionally) bootstrap it.
  bootstrap-template         Build pluxel dist + pnpm install (for this template repo).

Environment:
  PLUXEL_DIR        Path to a local pluxel repo (default: ../pluxel).

Init options:
  --name <name>       package.json name (default: basename of product_dir)
  --no-bootstrap      only scaffold, skip pnpm install/build
`)
}

function absDir(input) {
	return path.resolve(input)
}

async function ensureDir(dir) {
	await fs.mkdir(dir, { recursive: true })
}

async function isSymlink(p) {
	try {
		return (await fs.lstat(p)).isSymbolicLink()
	} catch {
		return false
	}
}

async function ensureRealDir(p) {
	if (await isSymlink(p)) {
		await fs.unlink(p)
	}
	await ensureDir(p)
}

function detectPluxelDir() {
	const env = process.env.PLUXEL_DIR
	if (env) return absDir(env)
	return absDir(path.join(templateRoot, '..', 'pluxel'))
}

async function linkFileOrDir(linkPath, targetPath) {
	const linkDir = path.dirname(linkPath)
	await ensureDir(linkDir)

	const relTarget = path.relative(linkDir, targetPath) || '.'

	try {
		const st = await fs.lstat(linkPath)
		if (st.isDirectory() && !st.isSymbolicLink()) {
			throw new Error(`refusing to replace real directory: ${linkPath}`)
		}
	} catch {}

	await fs.rm(linkPath, { force: true, recursive: false })
	await fs.symlink(relTarget, linkPath)
}

async function linkVendorTemplate(productDir) {
	const vendorRoot = path.join(productDir, 'vendor', 'pluxel-template')
	await ensureRealDir(vendorRoot)

	await linkFileOrDir(path.join(vendorRoot, 'packages'), path.join(templateRoot, 'packages'))
	await linkFileOrDir(path.join(vendorRoot, 'plugins'), path.join(templateRoot, 'plugins'))
	await linkFileOrDir(path.join(vendorRoot, 'agents'), path.join(templateRoot, 'agents'))
	await linkFileOrDir(path.join(vendorRoot, 'AGENTS.md'), path.join(templateRoot, 'AGENTS.md'))
}

async function linkVendorPluxel(productDir) {
	const pluxelDir = detectPluxelDir()
	const hmrPath = path.join(pluxelDir, 'packages', 'hmr')
	try {
		const stat = await fs.stat(hmrPath)
		if (!stat.isDirectory()) throw new Error('not a dir')
	} catch {
		throw new Error(`missing pluxel repo at ${pluxelDir} (set PLUXEL_DIR=/path/to/pluxel)`)
	}

	const vendorRoot = path.join(productDir, 'vendor', 'pluxel')
	await ensureRealDir(vendorRoot)

	await linkFileOrDir(path.join(vendorRoot, 'packages'), path.join(pluxelDir, 'packages'))
}

async function cmdLink(productDir) {
	const productAbs = absDir(productDir)
	const pkgJson = path.join(productAbs, 'package.json')
	try {
		await fs.stat(pkgJson)
	} catch {
		throw new Error(`not a repo root (missing package.json): ${productAbs}`)
	}

	await linkVendorTemplate(productAbs)
	await linkVendorPluxel(productAbs)
	process.stdout.write(`[setup] linked vendor in ${path.basename(productAbs)}\n`)
}

function runPnpm(cwd, args) {
	const res = spawnSync('pnpm', args, { cwd, stdio: 'inherit' })
	if (res.error) throw res.error
	if (typeof res.status === 'number' && res.status !== 0) process.exit(res.status)
}

function buildPluxelDist() {
	const pluxelDir = detectPluxelDir()
	const hmrPath = path.join(pluxelDir, 'packages', 'hmr')
	try {
		fsSync.statSync(hmrPath)
	} catch {
		throw new Error(`missing pluxel repo at ${pluxelDir} (set PLUXEL_DIR=/path/to/pluxel)`)
	}

	process.stdout.write('[setup] build upstream dist outputs (pluxel)\n')
	runPnpm(pluxelDir, ['install'])
	runPnpm(pluxelDir, ['--filter', '@pluxel/core', '--filter', '@pluxel/hmr', '--filter', '@pluxel/test', 'build'])
}

async function cmdBootstrap(productDir) {
	const productAbs = absDir(productDir)
	await cmdLink(productAbs)
	buildPluxelDist()
	process.stdout.write(`[setup] pnpm install (${productAbs})\n`)
	runPnpm(productAbs, ['install'])
}

async function cmdBootstrapTemplate() {
	buildPluxelDist()
	process.stdout.write(`[setup] pnpm install (${templateRoot})\n`)
	runPnpm(templateRoot, ['install'])
}

async function writeFileOnce(filePath, content) {
	await ensureDir(path.dirname(filePath))
	await fs.writeFile(filePath, content, { flag: 'wx' })
}

async function copyFileOnce(srcPath, destPath) {
	await ensureDir(path.dirname(destPath))
	await fs.copyFile(srcPath, destPath, fsSync.constants.COPYFILE_EXCL)
}

async function copyDirContentsOnce(srcDir, destDir) {
	const entries = await fs.readdir(srcDir, { withFileTypes: true })
	for (const ent of entries) {
		const src = path.join(srcDir, ent.name)
		const dest = path.join(destDir, ent.name)
		if (ent.isDirectory()) {
			await ensureDir(dest)
			await copyDirContentsOnce(src, dest)
		} else if (ent.isFile()) {
			await copyFileOnce(src, dest)
		} else if (ent.isSymbolicLink()) {
			const target = await fs.readlink(src)
			await fs.symlink(target, dest)
		}
	}
}

async function ensureEmptyDir(dir) {
	await ensureDir(dir)
	const entries = await fs.readdir(dir)
	if (entries.length > 0) {
		throw new Error(`target directory is not empty: ${dir}`)
	}
}

function parseInitOptions(args) {
	const opts = { name: null, bootstrap: true }
	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		if (a === '--no-bootstrap') {
			opts.bootstrap = false
			continue
		}
		if (a === '--name') {
			const v = args[i + 1]
			if (!v) throw new Error('missing value for --name')
			opts.name = v
			i++
			continue
		}
		throw new Error(`unknown option: ${a}`)
	}
	return opts
}

async function copyTemplateConfig(productAbs) {
	// "Major essentials" copied from template. Avoid copying vendored sources or template runtime data.
	const files = ['biome.jsonc', 'tsconfig.base.json', 'tsconfig.json']
	for (const f of files) {
		await copyFileOnce(path.join(templateRoot, f), path.join(productAbs, f))
	}
}

async function writeDownstreamPackageJson(productAbs, name) {
	const src = path.join(scaffoldRoot, 'package.json')
	const raw = await fs.readFile(src, 'utf8')
	const rendered = raw.replaceAll('__NAME__', name)
	await writeFileOnce(path.join(productAbs, 'package.json'), `${rendered.trim()}\n`)
}

async function cmdInit(productDir, args) {
	const productAbs = absDir(productDir)
	const opts = parseInitOptions(args)
	const name = opts.name ?? path.basename(productAbs)

	await ensureEmptyDir(productAbs)

	await copyTemplateConfig(productAbs)

	await copyDirContentsOnce(path.join(scaffoldRoot, 'base'), productAbs)
	await fs.chmod(path.join(productAbs, 'setup.mjs'), 0o755)
	await ensureDir(path.join(productAbs, 'plugins'))

	await writeDownstreamPackageJson(productAbs, name)

	process.stdout.write(`[setup] created downstream at ${productAbs}\n`)

	if (opts.bootstrap) {
		await cmdBootstrap(productAbs)
	}
}

const [cmd, arg1, ...rest] = process.argv.slice(2)
try {
	if (!cmd || cmd === '-h' || cmd === '--help') {
		usage()
		process.exit(0)
	}

	if (cmd === 'link') {
		await cmdLink(arg1 ?? process.cwd())
	} else if (cmd === 'bootstrap') {
		await cmdBootstrap(arg1 ?? process.cwd())
	} else if (cmd === 'init' || cmd === 'create') {
		if (!arg1) throw new Error('missing <product_dir>')
		await cmdInit(arg1, rest)
	} else if (cmd === 'bootstrap-template' || cmd === 'template-bootstrap') {
		await cmdBootstrapTemplate()
	} else {
		throw new Error(`unknown command: ${cmd}`)
	}
} catch (err) {
	process.stderr.write(`[setup] ${err instanceof Error ? err.message : String(err)}\n`)
	process.exit(2)
}
