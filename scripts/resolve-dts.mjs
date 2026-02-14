import { createResolver } from 'dts-resolver'

const rawArgs = process.argv.slice(2)
const specifier = rawArgs[0]
if (!specifier) {
	process.stderr.write('Missing <specifier>.\n')
	process.exit(2)
}

function takeFlag(args, flag) {
	const idx = args.indexOf(flag)
	if (idx === -1) return undefined
	const value = args[idx + 1]
	if (!value || value.startsWith('-')) {
		process.stderr.write(`Missing value for ${flag}.\n`)
		process.exit(2)
	}
	args.splice(idx, 2)
	return value
}

const args = rawArgs.slice(1)
const cwd = takeFlag(args, '--cwd')
const importer = takeFlag(args, '--importer')
if (args.length > 0) {
	process.stderr.write(`Unknown args: ${args.join(' ')}\n`)
	process.exit(2)
}

const resolver = createResolver({
	cwd: cwd || process.cwd(),
	resolveNodeModules: true,
})

const isDts = (p) => p.endsWith('.d.ts') || p.endsWith('.d.mts') || p.endsWith('.d.cts')

const resolved = resolver(specifier, importer)
if (resolved && isDts(resolved)) {
	process.stdout.write(resolved + '\n')
	process.exit(0)
}

const basePkg = (() => {
	if (specifier.startsWith('@')) {
		const parts = specifier.split('/')
		return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier
	}
	return specifier.split('/')[0]
})()

const atTypesPkg = (() => {
	if (basePkg.startsWith('@')) {
		const [scope, name] = basePkg.split('/')
		return `@types/${scope.slice(1)}__${name}`
	}
	return `@types/${basePkg}`
})()

const resolvedAtTypes = resolver(atTypesPkg, importer)
if (resolvedAtTypes && isDts(resolvedAtTypes)) {
	process.stdout.write(resolvedAtTypes + '\n')
	process.exit(0)
}

if (!resolved) {
	process.stderr.write(`Failed to resolve entry for: ${specifier}\n`)
	process.exit(2)
}

process.stderr.write(
	`No .d.ts found for ${specifier}; resolved entry: ${resolved}` +
		(resolvedAtTypes ? ` (and ${atTypesPkg}: ${resolvedAtTypes})` : '') +
		'\n',
)
process.stdout.write(resolved + '\n')

