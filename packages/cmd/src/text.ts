import type { AnyStdSchema } from './core'
import { CmdError, getInputJsonSchema } from './core'
import { defaultTokenizer, type TextToken, type TextTokenizer } from './tokenize'
import { splitSpace, uniqueStrings } from './internal/strings'
import type { TextInvocation } from './text-runner'
import type { TextTail } from './text-tail'

export type TextConfig = {
	/** Text triggers (command names). Default: `[id]`. */
	triggers?: string[]
	/**
	 * Optional ParseBox tail parser (text-only).
	 *
	 * When present, cmdkit parses "the rest of the text" with ParseBox and expects
	 * it to return an object patch merged into the real input (after flags parsing).
	 *
	 * Rules:
	 * - Patch keys MUST exist in the input schema
	 * - Patch MUST NOT override values already provided by keyed params
	 */
	tail?: TextTail
}

export type ParamType = 'string' | 'number' | 'boolean' | 'json' | 'string[]' | 'number[]' | 'boolean[]' | 'json[]'

export type ParamSpec = {
	name: string
	type: ParamType
	description?: string
	required?: boolean
	default?: unknown
	/** Extra long-form aliases accepted by the parser (without leading `--`). */
	aliases?: string[]
	/**
	 * Optional short form (single character).
	 *
	 * Rule: derived from schema at build-time; may be omitted on conflicts.
	 */
	short?: string
	/** When true, supports `--no-<name>` negation. */
	negate?: boolean
}

export type ExecutableMeta = {
	triggers: string[]
	params?: ParamSpec[]
	/** Presence indicates the command accepts a ParseBox tail (text-only). */
	tail?: true
}

export type CompiledText = {
	meta: ExecutableMeta
	tokenize: TextTokenizer
	match: (tokens: TextToken[]) => { consumed: number } | null
	parseCandidate: (inv: TextInvocation) => unknown
}

type InputModel =
	| { kind: 'emptyObject' }
	| { kind: 'string' }
	| { kind: 'number'; integer: boolean }
	| { kind: 'boolean' }
	| {
			kind: 'object'
			params: DerivedParam[]
			paramByAlias: Record<string, DerivedParam>
			paramByShort: Record<string, DerivedParam>
			propertyKeys: ReadonlySet<string>
	  }

type DerivedParam = {
	name: string
	inputKey: string
	type: ParamType
	integer?: boolean
	aliases?: string[]
	short?: string
	negate?: boolean
	required?: boolean
	description?: string
	default?: unknown
}

const INPUT_MODEL_CACHE = new WeakMap<object, InputModel>()

const isSafeName = (s: string) => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s)

const sanitizeName = (key: string) =>
	key
		.replace(/[\s.:=]/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '')

const toWords = (s: string) =>
	String(s)
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/[-_]+/g, ' ')
		.trim()
		.split(/\s+/g)
		.filter(Boolean)

const toKebabCase = (s: string) => toWords(s).map((w) => w.toLowerCase()).join('-')
const toSnakeCase = (s: string) => toWords(s).map((w) => w.toLowerCase()).join('_')

const toParamType = (schema: any): { type: ParamType; integer: boolean } | null => {
	const s = schema && typeof schema === 'object' ? schema : {}
	const types = Array.isArray(s.type) ? s.type.filter((t: any) => t !== 'null') : [s.type]
	const t = types.length === 1 ? types[0] : s.type
	if (t === 'array') {
		const item = toParamType(s.items)
		if (!item) return { type: 'json[]', integer: false }
		const base = item.type
		if (base === 'string') return { type: 'string[]', integer: false }
		if (base === 'boolean') return { type: 'boolean[]', integer: false }
		if (base === 'number') return { type: 'number[]', integer: item.integer }
		if (base === 'json') return { type: 'json[]', integer: false }
		// Nested arrays collapse to json[].
		return { type: 'json[]', integer: false }
	}
	if (t === 'string') return { type: 'string', integer: false }
	if (t === 'boolean') return { type: 'boolean', integer: false }
	if (t === 'integer') return { type: 'number', integer: true }
	if (t === 'number') return { type: 'number', integer: false }
	if (t === 'object') return { type: 'json', integer: false }
	return null
}

const deriveInputModel = (schema: AnyStdSchema): InputModel => {
	const cached = INPUT_MODEL_CACHE.get(schema as any)
	if (cached) return cached

	const js = getInputJsonSchema(schema)
	const root: any = js && typeof js === 'object' ? js : undefined
	if (!root || typeof root !== 'object') {
		throw new CmdError('E_INTERNAL', 'Internal error', { message: 'text(): requires JSON Schema for input schema derivation' })
	}

	// Special-case the built-in strict empty object schema.
	if (root.type === 'object' && root.properties && typeof root.properties === 'object' && Object.keys(root.properties).length === 0) {
		const m: InputModel = { kind: 'emptyObject' }
		INPUT_MODEL_CACHE.set(schema as any, m)
		return m
	}

	const t = toParamType(root)
	if (t && t.type !== 'json') {
		const m: InputModel =
			t.type === 'string'
				? { kind: 'string' }
				: t.type === 'boolean'
					? { kind: 'boolean' }
					: { kind: 'number', integer: t.integer }
		INPUT_MODEL_CACHE.set(schema as any, m)
		return m
	}

	if (root.type !== 'object' || !root.properties || typeof root.properties !== 'object') {
		throw new CmdError('E_INTERNAL', 'Internal error', { message: 'text(): input JSON Schema must be an object (or primitive)' })
	}

	const required = new Set<string>(Array.isArray(root.required) ? root.required.map(String) : [])
	const keys = Object.keys(root.properties as Record<string, any>).sort((a, b) => a.localeCompare(b))
	const propertyKeys = new Set<string>(keys.map(String))
	if (propertyKeys.has('_')) {
		throw new CmdError('E_INTERNAL', 'Internal error', { message: 'text(): reserved input key "_" is not allowed (tail is text-only; map it into real input fields)' })
	}

	const params: DerivedParam[] = []
	const canonicalByName: Record<string, DerivedParam> = {}

	for (const rawKey of keys) {
		const inputKey = String(rawKey)
		const prop = (root.properties as any)[rawKey]
		const propSchema = prop && typeof prop === 'object' ? prop : {}

		const tt = toParamType(propSchema)
		if (!tt) continue

		const description =
			typeof propSchema.description === 'string' && propSchema.description.trim()
				? String(propSchema.description)
				: typeof propSchema.title === 'string' && propSchema.title.trim()
					? String(propSchema.title)
					: undefined

		const base = isSafeName(inputKey) ? inputKey : sanitizeName(inputKey)
		const canonical = isSafeName(base) ? toKebabCase(base) : ''
		if (!canonical) continue

		const name = canonical
		if (canonicalByName[name]) {
			throw new CmdError('E_INTERNAL', 'Internal error', { message: `text(): derived param name collision "${name}"` })
		}

		const aliases = (() => {
			const out: string[] = []
			const push = (v: string) => {
				const s = String(v).trim()
				if (!s) return
				if (!isSafeName(s)) return
				if (s === name) return
				if (out.includes(s)) return
				out.push(s)
			}

			if (isSafeName(base)) push(base)
			push(toSnakeCase(base))
			// Also accept non-kebab original key when safe.
			if (isSafeName(inputKey)) push(inputKey)
			return out
		})()

		const shortCandidate = (() => {
			if (inputKey.length === 1 && isSafeName(inputKey)) return inputKey.toLowerCase()
			const c = name[0]
			return typeof c === 'string' && /^[a-zA-Z]$/.test(c) ? c.toLowerCase() : undefined
		})()

		const derived: DerivedParam = {
			name,
			inputKey,
			type: tt.type,
			...(tt.type === 'number' || tt.type === 'number[]' ? { integer: tt.integer } : {}),
			...(aliases.length ? { aliases } : {}),
			...(shortCandidate ? { short: shortCandidate } : {}),
			...(tt.type === 'boolean' ? { negate: true } : {}),
			...(required.has(inputKey) ? { required: true } : {}),
			...(description ? { description } : {}),
			...(propSchema.default !== undefined ? { default: propSchema.default } : {}),
		}
		params.push(derived)
		canonicalByName[name] = derived
	}

	// Build alias map: canonical names are always accepted.
	const paramByAlias: Record<string, DerivedParam> = {}
	for (const p of params) paramByAlias[p.name] = p

	// Add extra aliases only when unique (no collisions).
	const aliasCounts: Record<string, number> = {}
	for (const p of params) {
		for (const a of p.aliases ?? []) {
			aliasCounts[a] = (aliasCounts[a] ?? 0) + 1
		}
	}
	for (const p of params) {
		for (const a of p.aliases ?? []) {
			if ((aliasCounts[a] ?? 0) !== 1) continue
			if (paramByAlias[a] && paramByAlias[a] !== p) continue
			paramByAlias[a] = p
		}
	}

	// Keep ParamSpec consistent: only expose aliases that are actually accepted.
	for (const p of params) {
		if (!p.aliases?.length) continue
		const accepted = p.aliases.filter((a) => paramByAlias[a] === p)
		if (accepted.length) p.aliases = accepted
		else delete p.aliases
	}

	// Short flags: keep only unique candidates (conflicts => no short).
	const shortCounts: Record<string, number> = {}
	for (const p of params) {
		if (!p.short) continue
		shortCounts[p.short] = (shortCounts[p.short] ?? 0) + 1
	}
	const paramByShort: Record<string, DerivedParam> = {}
	for (const p of params) {
		if (!p.short) continue
		if ((shortCounts[p.short] ?? 0) !== 1) {
			delete p.short
			continue
		}
		paramByShort[p.short] = p
	}

	const m: InputModel = {
		kind: 'object',
		params,
		paramByAlias,
		paramByShort,
		propertyKeys,
	}
	INPUT_MODEL_CACHE.set(schema as any, m)
	return m
}

const parseBoolean = (raw: string): boolean | null => {
	const s = String(raw).trim().toLowerCase()
	if (s === 'true' || s === '1' || s === 'yes' || s === 'y' || s === 'on') return true
	if (s === 'false' || s === '0' || s === 'no' || s === 'n' || s === 'off') return false
	return null
}

const parseValue = (param: DerivedParam, raw: string): unknown => {
	if (param.type === 'string') return String(raw)
	if (param.type === 'boolean') {
		const b = parseBoolean(raw)
		if (b === null) throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: `Invalid boolean for "${param.name}": ${raw}` })
		return b
	}
	if (param.type === 'number') {
		const n = Number(raw)
		if (!Number.isFinite(n)) throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: `Invalid number for "${param.name}": ${raw}` })
		if (param.integer && !Number.isInteger(n)) throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: `Expected integer for "${param.name}"` })
		return n
	}
	if (param.type === 'string[]') {
		if (raw.trim().startsWith('[')) {
			const v = JSON.parse(raw)
			if (!Array.isArray(v)) throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: `Expected array for "${param.name}"` })
			return v.map((x) => String(x))
		}
		return raw
			.split(',')
			.map((x) => x.trim())
			.filter((x) => x.length > 0)
	}
	if (param.type === 'number[]') {
		const parts = raw.trim().startsWith('[')
			? (() => {
					const v = JSON.parse(raw)
					if (!Array.isArray(v)) throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: `Expected array for "${param.name}"` })
					return v.map((x) => String(x))
				})()
			: raw.split(',').map((x) => x.trim()).filter((x) => x.length > 0)
		return parts.map((p) => {
			const n = Number(p)
			if (!Number.isFinite(n)) throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: `Invalid number in "${param.name}": ${p}` })
			if (param.integer && !Number.isInteger(n)) throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: `Expected integer in "${param.name}": ${p}` })
			return n
		})
	}
	if (param.type === 'boolean[]') {
		const parts = raw.trim().startsWith('[')
			? (() => {
					const v = JSON.parse(raw)
					if (!Array.isArray(v)) throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: `Expected array for "${param.name}"` })
					return v.map((x) => String(x))
				})()
			: raw.split(',').map((x) => x.trim()).filter((x) => x.length > 0)
		return parts.map((p) => {
			const b = parseBoolean(p)
			if (b === null) throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: `Invalid boolean in "${param.name}": ${p}` })
			return b
		})
	}
	if (param.type === 'json[]') {
		const v = JSON.parse(raw)
		if (!Array.isArray(v)) throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: `Expected array for "${param.name}"` })
		return v
	}
	// json
	try {
		return JSON.parse(raw)
	} catch (e) {
		throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: `Invalid JSON for "${param.name}"`, cause: e })
	}
}

const parseObjectArgs = (
	model: Extract<InputModel, { kind: 'object' }>,
	inv: TextInvocation,
	tail: TextTail | undefined,
): Record<string, unknown> => {
	const argsTokens = inv.tokens.slice(inv.consumed)
	const out: Record<string, unknown> = {}
	const allowTail = !!tail

	const setValue = (param: DerivedParam, value: unknown) => {
		if (param.type.endsWith('[]')) {
			const arr = (out[param.inputKey] ?? []) as unknown[]
			const next = Array.isArray(value) ? value : [value]
			out[param.inputKey] = [...arr, ...next]
			return
		}
		out[param.inputKey] = value as any
	}

	const paramsByLong: Record<string, DerivedParam> = model.paramByAlias
	const paramsByShort: Record<string, DerivedParam> = model.paramByShort

	const isKnownKeyedToken = (v: string) => {
		if (v.startsWith('--no-')) {
			const name = v.slice('--no-'.length)
			return !!paramsByLong[name]
		}
		if (v.startsWith('--')) {
			const body = v.slice(2)
			const eq = body.indexOf('=')
			const name = eq >= 0 ? body.slice(0, eq) : body
			return !!paramsByLong[name]
		}
		// short: -c, -c=value, -cVALUE, -abc, -n10 ...
		if (v.length >= 2 && v[0] === '-' && v[1] !== '-' && /^[a-zA-Z]$/.test(v[1]!)) {
			const c = v[1]!.toLowerCase()
			return !!paramsByShort[c]
		}
		const c = v.indexOf(':')
		const e = v.indexOf('=')
		const idx = c < 0 ? e : e < 0 ? c : Math.min(c, e)
		if (idx > 0) {
			const name = v.slice(0, idx)
			return !!paramsByLong[name]
		}
		return false
	}

	let tailMode: 'explicit' | 'implicit' | null = null
	let tailTokens: TextToken[] | undefined

	for (let i = 0; i < argsTokens.length; i++) {
		const t = argsTokens[i]!
		const v = t.value

		// Explicit end-of-options sentinel: everything after this becomes tail.
		if (v === '--') {
			if (!allowTail) throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: 'Unexpected "--": this command has no tail' })
			tailMode = 'explicit'
			tailTokens = argsTokens.slice(i + 1)
			break
		}

		// --no-<name>
		if (v.startsWith('--no-')) {
			const name = v.slice('--no-'.length)
			const param = paramsByLong[name]
			if (!param) {
				throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: `Unknown param: ${name}` })
			}
			if (!param.negate) throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: `Param "${name}" does not support negation` })
			setValue(param, false)
			continue
		}

		// --<name>[=<value>]
		if (v.startsWith('--')) {
			const body = v.slice(2)
			const eq = body.indexOf('=')
			const name = eq >= 0 ? body.slice(0, eq) : body
			const param = paramsByLong[name]
			if (!param) {
				throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: `Unknown param: ${name}` })
			}

			if (param.type === 'boolean') {
				if (eq >= 0) {
					const rawVal = body.slice(eq + 1)
					setValue(param, parseValue(param, rawVal))
				} else {
					// optional explicit boolean value: --enabled false
					const next = argsTokens[i + 1]
					const b = next ? parseBoolean(next.value) : null
					if (b === null) {
						setValue(param, true)
					} else {
						i++
						setValue(param, b)
					}
				}
				continue
			}

			let rawVal: string | undefined
			if (eq >= 0) {
				rawVal = body.slice(eq + 1)
			} else {
				const next = argsTokens[i + 1]
				if (!next) throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: `Missing value for --${name}` })
				i++
				rawVal = next.value
			}
			setValue(param, parseValue(param, rawVal))
			continue
		}

		// -<c> (only when c is a known short param)
		if (v.length === 2 && v.startsWith('-') && !v.startsWith('--')) {
			const c = v.slice(1).toLowerCase()
			const param = paramsByShort[c]
			if (param) {
				if (param.type === 'boolean') {
					// optional explicit boolean value: -f false
					const next = argsTokens[i + 1]
					const b = next ? parseBoolean(next.value) : null
					if (b === null) {
						setValue(param, true)
						continue
					}
					i++
					setValue(param, b)
					continue
				}
				const next = argsTokens[i + 1]
				if (!next) throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: `Missing value for -${c}` })
				i++
				setValue(param, parseValue(param, next.value))
				continue
			}
			// Unknown short flag; allow negative numbers (e.g. -1) to fall through.
			if (/^[a-zA-Z]$/.test(c)) {
				throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: `Unknown param: -${c}` })
			}
		}
		// -abc short bundling (boolean only)
		if (/^-[a-zA-Z]{2,}$/.test(v)) {
			const chars = v.slice(1).toLowerCase().split('')
			const allBool = chars.every((c) => paramsByShort[c]?.type === 'boolean')
			if (allBool) {
				for (const c of chars) setValue(paramsByShort[c]!, true)
				continue
			}

			const c0 = chars[0]!
			const p0 = paramsByShort[c0]
			if (!p0) throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: `Unknown param: -${c0}` })
			if (p0.type === 'boolean') {
				throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: `Invalid short flags: ${v}` })
			}
			setValue(p0, parseValue(p0, v.slice(2)))
			continue
		}
		// -c=value
		if (/^-[a-zA-Z]=/.test(v)) {
			const c = v[1]!.toLowerCase()
			const rawVal = v.slice(3)
			const param = paramsByShort[c]
			if (!param) throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: `Unknown param: -${c}` })
			setValue(param, parseValue(param, rawVal))
			continue
		}
		// -cVALUE (attached value)
		if (/^-[a-zA-Z].+/.test(v) && !v.startsWith('--')) {
			const c = v[1]!.toLowerCase()
			const param = paramsByShort[c]
			if (!param) throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: `Unknown param: -${c}` })
			if (param.type === 'boolean') {
				throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: `Boolean short flag cannot take an attached value: -${c}` })
			}
			setValue(param, parseValue(param, v.slice(2)))
			continue
		}

		// key:value or key=value
		const sepIdx = (() => {
			const c = v.indexOf(':')
			const e = v.indexOf('=')
			if (c < 0) return e
			if (e < 0) return c
			return Math.min(c, e)
		})()
		if (sepIdx > 0) {
			const name = v.slice(0, sepIdx)
			const rawVal = v.slice(sepIdx + 1)
			const param = paramsByLong[name]
			if (param) {
				setValue(param, parseValue(param, rawVal))
				continue
			}
		}

		// Start ParseBox tail at the first non-option token.
		if (!allowTail) {
			throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: 'Unexpected arguments' })
		}
		tailMode = 'implicit'
		tailTokens = argsTokens.slice(i)
		break
	}

	if (tailMode) {
		if (!tail) {
			throw new CmdError('E_INTERNAL', 'Internal error', { message: 'text(): missing tail parser' })
		}

		if (tailMode === 'implicit' && tailTokens && tailTokens.some((tok) => isKnownKeyedToken(tok.value))) {
			throw new CmdError('E_TEXT_PARSE', 'Invalid text', {
				message: 'Keyed params must appear before tail (use `--` to start tail explicitly)',
			})
		}

		const tailText =
			tailTokens && tailTokens.length > 0
				? typeof inv.text === 'string'
					? inv.text.slice(tailTokens[0]!.start)
					: tailTokens.map((t) => t.raw).join(' ')
				: ''

		const parsed = (tail.module as any).Parse((tail as any).entry, tailText) as [] | [unknown, string]
		if (!Array.isArray(parsed) || parsed.length !== 2) {
			throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: 'Failed to parse tail' })
		}
		const [value, rest] = parsed
		if (typeof rest === 'string' && rest.trim().length > 0) {
			throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: 'Unexpected trailing input in tail' })
		}

		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: 'Tail parser must return an object patch' })
		}
		for (const [k, v2] of Object.entries(value as Record<string, unknown>)) {
			if (!model.propertyKeys.has(k)) {
				throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: `Tail produced unknown key: ${k}` })
			}
			if (Object.prototype.hasOwnProperty.call(out, k)) {
				throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: `Tail cannot override param: ${k}` })
			}
			out[k] = v2
		}
	}

	return out
}

const matchAnyName = (names: ReadonlyArray<readonly string[]>, tokens: TextToken[]) => {
	let best: { consumed: number } | undefined
	for (const n of names) {
		if (n.length === 0) continue
		if (tokens.length < n.length) continue
		let ok = true
		for (let i = 0; i < n.length; i++) {
			const token = tokens[i]!.value
			const expected = n[i]!
			if (token !== expected) {
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
	const tokenizedNames = triggers.map(splitSpace).filter((x) => x.length > 0)

	if (tokenizedNames.length === 0) {
		throw new CmdError('E_INTERNAL', 'Internal error', { message: 'text(): requires at least one trigger' })
	}

	const tokenize = defaultTokenizer
	const model = deriveInputModel(inputSchema)

	let paramsMeta: ParamSpec[] | undefined
	if (model.kind === 'object') {
		paramsMeta = model.params.map((p) => ({
			name: p.name,
			type: p.type,
			...(p.description ? { description: p.description } : {}),
			...(p.required ? { required: true } : {}),
			...(p.default !== undefined ? { default: p.default } : {}),
			...(p.aliases?.length ? { aliases: p.aliases.slice() } : {}),
			...(p.short ? { short: p.short } : {}),
			...(p.negate ? { negate: true } : {}),
		}))
	} else if (cfg.tail) {
		throw new CmdError('E_INTERNAL', 'Internal error', { message: 'text({ tail }): only supported for object input schemas' })
	}

	const meta: ExecutableMeta = {
		triggers,
		...(paramsMeta && paramsMeta.length ? { params: paramsMeta } : {}),
		...(cfg.tail ? { tail: true } : {}),
	}

	return {
		meta,
		tokenize,
		match: (tokens) => matchAnyName(tokenizedNames, tokens),
		parseCandidate: (inv) => {
			const argsTokens = inv.tokens.slice(inv.consumed)
			if (model.kind === 'emptyObject') {
				if (argsTokens.length > 0) throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: 'This command takes no arguments' })
				return {}
			}
			if (model.kind === 'string') {
				return argsTokens.map((t) => t.value).join(' ')
			}
			if (model.kind === 'number') {
				if (argsTokens.length === 0) throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: 'Missing number' })
				if (argsTokens.length > 1) throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: 'Too many arguments' })
				const n = Number(argsTokens[0]!.value)
				if (!Number.isFinite(n)) throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: 'Invalid number' })
				if (model.integer && !Number.isInteger(n)) throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: 'Expected integer' })
				return n
			}
			if (model.kind === 'boolean') {
				if (argsTokens.length === 0) throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: 'Missing boolean' })
				if (argsTokens.length > 1) throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: 'Too many arguments' })
				const b = parseBoolean(argsTokens[0]!.value)
				if (b === null) throw new CmdError('E_TEXT_PARSE', 'Invalid text', { message: 'Invalid boolean' })
				return b
			}
			return parseObjectArgs(model, inv, cfg.tail)
		},
	}
}
