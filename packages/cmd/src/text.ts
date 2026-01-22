import type { AnyStdSchema } from './core'
import { CmdError, getInputJsonSchema } from './core'
import { createTypeFlagAdapter } from './argv/type-flag'
import type { ArgvAdapter, FlagSpec, ParsedArgv } from './argv/types'
import { defaultTokenizer, type TextTokenizer } from './tokenize'
import { splitSpace, uniqueStrings } from './internal/strings'

export type TextConfig = {
	/** Text triggers (command names). Default: `[id]`. */
	triggers?: string[]
	tokenize?: TextTokenizer
	/**
	 * Controls trigger matching for `exec.execText(...)` only.
	 * - Router case-insensitivity is configured via `createRouter({ caseInsensitive: true })`.
	 */
	caseInsensitive?: boolean

	adapter?: ArgvAdapter
	flags?: FlagSpec[]
	map?: (parsed: ParsedArgv) => unknown
	allowUnknownFlags?: boolean
	typeFlagOptions?: unknown
}

export type TextMapFn = NonNullable<TextConfig['map']>

export type ExecutableMeta = {
	triggers: string[]
	flags?: FlagSpec[]
}

export type CompiledText = {
	meta: ExecutableMeta
	tokenize: TextTokenizer
	match: (tokens: string[]) => { consumed: number } | null
	argv: {
		parse: (tokens: string[]) => ParsedArgv
		flags: FlagSpec[]
		map: (parsed: ParsedArgv) => unknown
	}
}

const validateFlags = (flags: readonly FlagSpec[]) => {
	const seenNames = new Set<string>()
	const seenAliases = new Set<string>()

	for (const f of flags) {
		const name = String(f.name ?? '').trim()
		if (!name) throw new CmdError('E_INTERNAL', 'Internal error', { message: 'text(): flag name must be non-empty' })
		if (/\s/.test(name)) {
			throw new CmdError('E_INTERNAL', 'Internal error', { message: `text(): invalid flag name "${name}"` })
		}
		if (seenNames.has(name)) {
			throw new CmdError('E_INTERNAL', 'Internal error', { message: `text(): duplicate flag name "${name}"` })
		}
		seenNames.add(name)

		const aliasList = (f.alias ?? []).map(String).map((x) => x.trim()).filter(Boolean)
		for (const a of aliasList) {
			if (/\s/.test(a)) {
				throw new CmdError('E_INTERNAL', 'Internal error', { message: `text(): invalid flag alias "${a}"` })
			}
			if (seenAliases.has(a)) {
				throw new CmdError('E_INTERNAL', 'Internal error', { message: `text(): duplicate flag alias "${a}"` })
			}
			seenAliases.add(a)
		}
	}
}

const DERIVED_FLAGS_CACHE = new WeakMap<object, { flags: FlagSpec[]; flagToInputKey: Record<string, string> }>()

const deriveFlagsFromInputSchema = (
	schema: AnyStdSchema,
): { flags: FlagSpec[]; flagToInputKey: Record<string, string> } => {
	const cached = DERIVED_FLAGS_CACHE.get(schema as any)
	if (cached) return cached

	const js = getInputJsonSchema(schema)
	const root: any = js && typeof js === 'object' ? js : undefined
	if (!root || root.type !== 'object' || !root.properties || typeof root.properties !== 'object') {
		const empty = { flags: [], flagToInputKey: {} }
		DERIVED_FLAGS_CACHE.set(schema as any, empty)
		return empty
	}

	const required = new Set<string>(Array.isArray(root.required) ? root.required.map(String) : [])
	const out: FlagSpec[] = []
	const flagToInputKey: Record<string, string> = {}
	const seen = new Set<string>()

	const invalid = /[\s.:=]/
	const replace = /[\s.:=]/g
	const sanitize = (key: string) => key.replace(replace, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')

	const keys = Object.keys(root.properties as Record<string, any>).sort((a, b) => a.localeCompare(b))
	for (const rawKey of keys) {
		const prop = (root.properties as any)[rawKey]
		const key = String(rawKey)
		const s = prop && typeof prop === 'object' ? prop : {}
		const types = Array.isArray(s.type) ? s.type.filter((t: any) => t !== 'null') : [s.type]
		const t = types.length === 1 ? types[0] : s.type

		const baseType =
			t === 'string'
				? 'string'
				: t === 'number' || t === 'integer'
					? 'number'
					: t === 'boolean'
						? 'boolean'
						: undefined
		if (!baseType) continue

		const description =
			typeof s.description === 'string' && s.description.trim()
				? String(s.description)
				: typeof s.title === 'string' && s.title.trim()
					? String(s.title)
					: undefined

		let name = key
		let alias: string[] | undefined
		if (name.length === 1 && !invalid.test(name)) {
			name = `${name}_`
			alias = [key]
		} else if (invalid.test(name)) {
			const sanitized = sanitize(name)
			if (!sanitized || invalid.test(sanitized)) continue
			name = sanitized
		}

		if (seen.has(name)) {
			throw new CmdError('E_INTERNAL', 'Internal error', {
				message: `text(): derived flag name collision "${name}" (provide text({ flags: [...] }) to disambiguate)`,
			})
		}
		seen.add(name)

		out.push({
			name,
			...(alias?.length ? { alias } : {}),
			type: baseType,
			...(description ? { description } : {}),
			...(baseType === 'boolean' ? { negate: true } : {}),
			...(required.has(key) ? { required: true } : {}),
			...(s.default !== undefined ? { default: s.default } : {}),
		})

		flagToInputKey[name] = key
	}

	const derived = { flags: out, flagToInputKey }
	DERIVED_FLAGS_CACHE.set(schema as any, derived)
	return derived
}

const matchAnyName = (names: ReadonlyArray<readonly string[]>, tokens: string[], caseInsensitive: boolean) => {
	let best: { consumed: number } | undefined
	for (const n of names) {
		if (n.length === 0) continue
		if (tokens.length < n.length) continue
		let ok = true
		for (let i = 0; i < n.length; i++) {
			const token = tokens[i]!
			const expected = n[i]!
			const a = caseInsensitive ? token.toLowerCase() : token
			const b = expected
			if (a !== b) {
				ok = false
				break
			}
		}
		if (!ok) continue
		if (!best || n.length > best.consumed) best = { consumed: n.length }
	}
	return best ?? null
}

export const compileTextPlan = (id: string, inputSchema: AnyStdSchema, cfg: TextConfig): CompiledText => {
	const providedTriggers = cfg.triggers ? uniqueStrings(cfg.triggers) : []
	const triggers = providedTriggers.length > 0 ? providedTriggers : [id]
	const caseInsensitive = !!cfg.caseInsensitive

	const tokenizedNames = triggers
		.map(splitSpace)
		.filter((x) => x.length > 0)
		.map((xs) => (caseInsensitive ? xs.map((t) => t.toLowerCase()) : xs))

	if (tokenizedNames.length === 0) {
		throw new CmdError('E_INTERNAL', 'Internal error', { message: 'text(): requires at least one trigger' })
	}

	const tokenize = cfg.tokenize ?? defaultTokenizer

	const allowUnknownFlags = cfg.allowUnknownFlags ?? false
	const adapter = cfg.adapter ?? createTypeFlagAdapter()

	let flags: FlagSpec[]
	let flagToInputKey: Record<string, string> | undefined
	if (cfg.flags) {
		validateFlags(cfg.flags)
		flags = cfg.flags
	} else if (cfg.map) {
		// If user provides a custom mapper, default to positionals-only (no auto flags),
		// to avoid surprising "required --x" errors for required schema fields.
		flags = []
	} else {
		const derived = deriveFlagsFromInputSchema(inputSchema)
		flags = derived.flags
		flagToInputKey = derived.flagToInputKey
	}

	const map: (parsed: ParsedArgv) => unknown =
		cfg.map ??
		((() => {
			if (!flagToInputKey) return (p: ParsedArgv) => p.flags
			const pairs = Object.entries(flagToInputKey)
			return (p: ParsedArgv) => {
				const out: Record<string, unknown> = {}
				for (const [flagKey, inputKey] of pairs) {
					const v = (p.flags as any)[flagKey]
					if (v !== undefined) out[inputKey] = v
				}
				return out
			}
		})())

	const meta: ExecutableMeta = {
		triggers,
		...(flags.length ? { flags } : {}),
	}

	const typeFlagOptions = cfg.typeFlagOptions
	const parse =
		typeof adapter.precompile === 'function'
			? adapter.precompile({
					flags,
					allowUnknownFlags,
					...(typeFlagOptions ? { typeFlagOptions } : {}),
				})
			: (tokens: string[]) =>
					adapter.parse(tokens, {
						flags,
						allowUnknownFlags,
						...(typeFlagOptions ? { typeFlagOptions } : {}),
					})

	return {
		meta,
		tokenize,
		match: (tokens) => matchAnyName(tokenizedNames, tokens, caseInsensitive),
		argv: { parse, flags, map },
	}
}
