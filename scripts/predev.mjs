import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const configPath = resolve(repoRoot, process.env.PLUXEL_HMR_CONFIG ?? 'pluxel.hmr.jsonc')

function stripJsoncComments(input) {
	let output = ''
	let inString = false
	let stringQuote = ''
	let escaped = false

	for (let i = 0; i < input.length; i++) {
		const ch = input[i]
		const next = input[i + 1]

		if (inString) {
			output += ch
			if (escaped) {
				escaped = false
				continue
			}
			if (ch === '\\\\') {
				escaped = true
				continue
			}
			if (ch === stringQuote) {
				inString = false
				stringQuote = ''
			}
			continue
		}

		if (ch === '"' || ch === "'") {
			inString = true
			stringQuote = ch
			output += ch
			continue
		}

		if (ch === '/' && next === '/') {
			i += 1
			while (i + 1 < input.length && input[i + 1] !== '\n') i++
			continue
		}

		if (ch === '/' && next === '*') {
			i += 1
			while (i + 1 < input.length) {
				if (input[i] === '*' && input[i + 1] === '/') {
					i += 1
					break
				}
				i++
			}
			continue
		}

		output += ch
	}

	return output
}

function removeTrailingCommas(input) {
	let output = ''
	let inString = false
	let stringQuote = ''
	let escaped = false

	for (let i = 0; i < input.length; i++) {
		const ch = input[i]

		if (inString) {
			output += ch
			if (escaped) {
				escaped = false
				continue
			}
			if (ch === '\\\\') {
				escaped = true
				continue
			}
			if (ch === stringQuote) {
				inString = false
				stringQuote = ''
			}
			continue
		}

		if (ch === '"' || ch === "'") {
			inString = true
			stringQuote = ch
			output += ch
			continue
		}

		if (ch === ',') {
			let j = i + 1
			while (j < input.length && /\s/.test(input[j])) j++
			const next = input[j]
			if (next === '}' || next === ']') continue
		}

		output += ch
	}

	return output
}

function parseJsonc(text, { filename }) {
	const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
	const stripped = stripJsoncComments(withoutBom)
	const normalized = removeTrailingCommas(stripped)
	try {
		return JSON.parse(normalized)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		throw new Error(`Failed to parse JSONC (${filename}): ${message}`)
	}
}

function run(cmd, args) {
	const result = spawnSync(cmd, args, { stdio: 'inherit' })
	if (result.error) throw result.error
	if (typeof result.status === 'number' && result.status !== 0) process.exit(result.status)
}

const configText = await readFile(configPath, 'utf8')
const config = parseJsonc(configText, { filename: configPath })

const profileName = process.env.PLUXEL_HMR_PROFILE ?? config.profile ?? 'default'
const profile = (config.profiles && config.profiles[profileName]) || {}
const builtinPkgs = Array.isArray(profile.builtin)
	? [...new Set(profile.builtin)].filter((x) => typeof x === 'string' && x.length > 0)
	: []

if (builtinPkgs.length > 0) {
	run('pnpm', ['-s', 'turbo', 'build:builtin', ...builtinPkgs.flatMap((name) => ['--filter', name])])
}
