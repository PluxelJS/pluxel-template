import type { Schema } from './core'
import { CmdError, toJsonSchema } from './core'
import { defaultTokenizer, type TextToken, type TextTokenizer } from './tokenize'
import { splitSpace, uniqueStrings } from './internal/strings'
import type { TextInvocation } from './text-runner'
import type { TextTail } from './tail'

export type TextConfig<TInput = any> = {
	/** Text triggers (command names). Default: `[id]`. */
	triggers?: string[]

	/**
	 * Optional ParseBox tail parser (text-only).
	 *
	 * When present, @pluxel/cmd parses "the rest of the text" with ParseBox and expects
	 * it to return an object patch merged into the real input (after flags parsing).
	 *
	 * Note: @pluxel/cmd appends a trailing `\n` to the tail text before invoking ParseBox,
	 * so `Runtime.Until(['\n'], ...)` works as “until end-of-line”.
	 *
	 * Rules:
	 * - Patch keys MUST exist in the input schema
	 * - Patch MUST NOT override values already provided by keyed params
	 */
	tail?: TextTail<any, any, Partial<TInput>>

	/**
	 * Convenience "raw tail": map the remaining text into a single input field.
	 *
	 * Compared to `tail` (ParseBox), this is a zero-dependency option that keeps the same
	 * tail start rules (`--` sentinel or first non-option token), but simply assigns the
	 * rest of the text (trimmed) into the given input key.
	 *
	 * Rules:
	 * - Only supported for object input schemas
	 * - `tail` and `tailTo` are mutually exclusive
	 * - `tailTo` MUST exist in the input schema
	 * - `tailTo` MUST NOT override values already provided by keyed params
	 */
	tailTo?: Extract<keyof TInput, string>
}

export type ParamType = 'string' | 'number' | 'boolean' | 'json' | 'string[]' | 'number[]' | 'boolean[]' | 'json[]'

export type ParamSpec = {
	name: string
	/**
	 * Original input key in the schema (before canonicalization to kebab-case).
	 *
	 * Useful for mapping help/meta back to the actual validated input shape.
	 */
	inputKey?: string
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
	/** When present, indicates a raw tail target key (`text({ tailTo })`). */
	tailTo?: string
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
	aliasesExplicit?: string[]
	short?: string
	shortKind?: 'auto' | 'explicit'
	negate?: boolean
	required?: boolean
	description?: string
	default?: unknown
}

const INPUT_MODEL_CACHE = new WeakMap<object, InputModel>()

const isSafeName = (s: string) => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s)

const X_CMD_ALIASES = 'x-cmd-aliases'
const X_CMD_SHORT = 'x-cmd-short'

const SAFE_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/

const normalizeExplicitAliases = (schema: Record<string, unknown>, ctx: { param: string }) => {
	const raw = schema[X_CMD_ALIASES]
	if (raw === undefined) return undefined

	const list =
		typeof raw === 'string'
			? [raw]
			: Array.isArray(raw)
				? raw
				: (() => {
						throw new CmdError('E_INTERNAL', 'Internal error', {
							message: `text(): ${ctx.param} has invalid ${X_CMD_ALIASES}; expected string[] | string`,
						})
					})()

	const out: string[] = []
	for (const v of list) {
		if (typeof v !== 'string') {
			throw new CmdError('E_INTERNAL', 'Internal error', {
				message: `text(): ${ctx.param} has invalid ${X_CMD_ALIASES}; expected string[] | string`,
			})
		}
		const s = v.trim()
		if (!s) continue
		if (!isSafeName(s)) {
			throw new CmdError('E_INTERNAL', 'Internal error', {
				message: `text(): ${ctx.param} has invalid alias "${s}" (must match ${SAFE_NAME_RE})`,
			})
		}
		if (!out.includes(s)) out.push(s)
	}
	return out.length ? out : undefined
}

const normalizeExplicitShort = (schema: Record<string, unknown>, ctx: { param: string }) => {
	const raw = schema[X_CMD_SHORT]
	if (raw === undefined) return { kind: 'auto' as const }
	if (raw === null || raw === false) return { kind: 'disabled' as const }
	if (typeof raw !== 'string') {
		throw new CmdError('E_INTERNAL', 'Internal error', {
			message: `text(): ${ctx.param} has invalid ${X_CMD_SHORT}; expected string | null | false`,
		})
	}
	const s = raw.trim()
	if (!s) return { kind: 'auto' as const }
	if (!/^[a-zA-Z]$/.test(s)) {
		throw new CmdError('E_INTERNAL', 'Internal error', {
			message: `text(): ${ctx.param} has invalid short "${s}" (expected a single letter)`,
		})
	}
	return { kind: 'explicit' as const, short: s.toLowerCase() }
}

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

const deriveInputModel = (schema: Schema): InputModel => {
	const cached = INPUT_MODEL_CACHE.get(schema as any)
	if (cached) return cached

	const js = toJsonSchema(schema)
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

		const explicitAliases = normalizeExplicitAliases(propSchema, { param: `"${inputKey}"` })

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
			for (const a of explicitAliases ?? []) push(a)
			return out
		})()

		const shortCfg = normalizeExplicitShort(propSchema, { param: `"${inputKey}"` })
		const shortCandidate =
			shortCfg.kind === 'explicit'
				? shortCfg.short
				: shortCfg.kind === 'disabled'
					? undefined
					: (() => {
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
			...(explicitAliases?.length ? { aliasesExplicit: explicitAliases.slice() } : {}),
			...(shortCandidate ? { short: shortCandidate } : {}),
			...(shortCandidate
				? { shortKind: shortCfg.kind === 'explicit' ? ('explicit' as const) : ('auto' as const) }
				: {}),
			...(tt.type === 'boolean' ? { negate: true } : {}),
			...(required.has(inputKey) && propSchema.default === undefined ? { required: true } : {}),
			...(description ? { description } : {}),
			...(propSchema.default !== undefined ? { default: propSchema.default } : {}),
		}
		params.push(derived)
		canonicalByName[name] = derived
	}

	// Build alias map: canonical names are always accepted.
	const paramByAlias: Record<string, DerivedParam> = {}
	for (const p of params) paramByAlias[p.name] = p

	// Explicit aliases are "hard": collisions are configuration errors (build-time).
	const explicitAliasOwner: Record<string, DerivedParam> = {}
	for (const p of params) {
		for (const a of p.aliasesExplicit ?? []) {
			if (paramByAlias[a] && paramByAlias[a] !== p) {
				throw new CmdError('E_INTERNAL', 'Internal error', {
					message: `text(): explicit alias "${a}" conflicts with param "${paramByAlias[a]!.name}"`,
				})
			}
			if (explicitAliasOwner[a] && explicitAliasOwner[a] !== p) {
				throw new CmdError('E_INTERNAL', 'Internal error', {
					message: `text(): explicit alias "${a}" is declared by both "${explicitAliasOwner[a]!.name}" and "${p.name}"`,
				})
			}
			explicitAliasOwner[a] = p
		}
	}
	for (const [a, p] of Object.entries(explicitAliasOwner)) paramByAlias[a] = p

	// Auto aliases are "soft": only accept unique ones (collisions => drop).
	const autoAliasCounts: Record<string, number> = {}
	for (const p of params) {
		for (const a of p.aliases ?? []) {
			if (p.aliasesExplicit?.includes(a)) continue
			if (paramByAlias[a] && paramByAlias[a] !== p) continue
			autoAliasCounts[a] = (autoAliasCounts[a] ?? 0) + 1
		}
	}
	for (const p of params) {
		for (const a of p.aliases ?? []) {
			if (p.aliasesExplicit?.includes(a)) continue
			if ((autoAliasCounts[a] ?? 0) !== 1) continue
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

	// Short flags:
	// - explicit short wins against auto short
	// - explicit-explicit conflicts are errors (build-time)
	// - auto-auto conflicts => drop all
	const shortOwners: Record<string, DerivedParam[]> = {}
	for (const p of params) {
		if (!p.short) continue
		;(shortOwners[p.short] ??= []).push(p)
	}
	for (const [short, owners] of Object.entries(shortOwners)) {
		if (owners.length <= 1) continue
		const explicit = owners.filter((o) => o.shortKind === 'explicit')
		if (explicit.length > 1) {
			throw new CmdError('E_INTERNAL', 'Internal error', {
				message: `text(): short "-${short}" is declared by multiple params: ${explicit.map((p) => `"${p.name}"`).join(', ')}`,
			})
		}
		if (explicit.length === 1) {
			for (const o of owners) {
				if (o !== explicit[0]) {
					delete o.short
					delete o.shortKind
				}
			}
		} else {
			for (const o of owners) {
				delete o.short
				delete o.shortKind
			}
		}
	}

	const paramByShort: Record<string, DerivedParam> = {}
	for (const p of params) {
		if (!p.short) continue
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

const parseJson = (raw: string, paramName: string): unknown => {
	try {
		return JSON.parse(raw)
	} catch (e) {
		textParse({ reason: 'INVALID_JSON', message: `Invalid JSON for "${paramName}"`, param: paramName, cause: e })
	}
}

const editDistanceCutoff = (aRaw: string, bRaw: string, cutoff: number): number | null => {
	const a = aRaw.toLowerCase()
	const b = bRaw.toLowerCase()
	if (a === b) return 0
	const al = a.length
	const bl = b.length
	if (Math.abs(al - bl) > cutoff) return null

	const prev: number[] = new Array(bl + 1)
	const cur: number[] = new Array(bl + 1)
	for (let j = 0; j <= bl; j++) prev[j] = j

	for (let i = 1; i <= al; i++) {
		cur[0] = i
		let bestInRow = cur[0]!
		const ai = a.charCodeAt(i - 1)
		for (let j = 1; j <= bl; j++) {
			const cost = ai === b.charCodeAt(j - 1) ? 0 : 1
			const del = prev[j]! + 1
			const ins = cur[j - 1]! + 1
			const sub = prev[j - 1]! + cost
			const v = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub
			cur[j] = v
			if (v < bestInRow) bestInRow = v
		}
		if (bestInRow > cutoff) return null
		for (let j = 0; j <= bl; j++) prev[j] = cur[j]!
	}
	return prev[bl]! <= cutoff ? prev[bl]! : null
}

const suggestLongParam = (name: string, params: ReadonlyArray<DerivedParam>): string | null => {
	const s = String(name ?? '').trim()
	if (!s) return null
	if (s.length > 64) return null

	// Prefer canonical names for suggestions (stable + help text friendly).
	const candidates = params.map((p) => p.name)
	let best: { name: string; d: number } | undefined
	for (const c of candidates) {
		const d = editDistanceCutoff(s, c, 3)
		if (d === null) continue
		if (!best || d < best.d) best = { name: c, d }
	}
	return best ? best.name : null
}

const textParse: (opts: {
	reason: string
	message: string
	param?: string
	suggestion?: string
	at?: { start?: number; end?: number; raw?: string }
	cause?: unknown
}) => never = (opts) => {
	throw new CmdError('E_TEXT_PARSE', 'Invalid text', {
		message: opts.message,
		details: {
			reason: opts.reason,
			message: opts.message,
			...(opts.param ? { param: opts.param } : {}),
			...(opts.suggestion ? { suggestion: opts.suggestion } : {}),
			...(opts.at ? { at: opts.at } : {}),
		},
		...(opts.cause !== undefined ? { cause: opts.cause } : {}),
	})
}

const parseValue = (param: DerivedParam, raw: string): unknown => {
	if (param.type === 'string') return String(raw)
	if (param.type === 'boolean') {
		const b = parseBoolean(raw)
		if (b === null) textParse({ reason: 'INVALID_BOOLEAN', message: `Invalid boolean for "${param.name}": ${raw}`, param: param.name })
		return b
	}
	if (param.type === 'number') {
		const n = Number(raw)
		if (!Number.isFinite(n)) textParse({ reason: 'INVALID_NUMBER', message: `Invalid number for "${param.name}": ${raw}`, param: param.name })
		if (param.integer && !Number.isInteger(n)) textParse({ reason: 'EXPECTED_INTEGER', message: `Expected integer for "${param.name}"`, param: param.name })
		return n
	}
	if (param.type === 'string[]') {
		if (raw.trim().startsWith('[')) {
			const v = parseJson(raw, param.name)
			if (!Array.isArray(v)) textParse({ reason: 'EXPECTED_ARRAY', message: `Expected array for "${param.name}"`, param: param.name })
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
					const v = parseJson(raw, param.name)
					if (!Array.isArray(v)) textParse({ reason: 'EXPECTED_ARRAY', message: `Expected array for "${param.name}"`, param: param.name })
					return v.map((x) => String(x))
				})()
			: raw.split(',').map((x) => x.trim()).filter((x) => x.length > 0)
		return parts.map((p) => {
			const n = Number(p)
			if (!Number.isFinite(n)) textParse({ reason: 'INVALID_NUMBER', message: `Invalid number in "${param.name}": ${p}`, param: param.name })
			if (param.integer && !Number.isInteger(n)) textParse({ reason: 'EXPECTED_INTEGER', message: `Expected integer in "${param.name}": ${p}`, param: param.name })
			return n
		})
	}
	if (param.type === 'boolean[]') {
		const parts = raw.trim().startsWith('[')
			? (() => {
					const v = parseJson(raw, param.name)
					if (!Array.isArray(v)) textParse({ reason: 'EXPECTED_ARRAY', message: `Expected array for "${param.name}"`, param: param.name })
					return v.map((x) => String(x))
				})()
			: raw.split(',').map((x) => x.trim()).filter((x) => x.length > 0)
		return parts.map((p) => {
			const b = parseBoolean(p)
			if (b === null) textParse({ reason: 'INVALID_BOOLEAN', message: `Invalid boolean in "${param.name}": ${p}`, param: param.name })
			return b
		})
	}
	if (param.type === 'json[]') {
		const v = parseJson(raw, param.name)
		if (!Array.isArray(v)) textParse({ reason: 'EXPECTED_ARRAY', message: `Expected array for "${param.name}"`, param: param.name })
		return v
	}
	// json
	return parseJson(raw, param.name)
}

const parseObjectArgs = (
	model: Extract<InputModel, { kind: 'object' }>,
	inv: TextInvocation,
	tail: TextTail | undefined,
	tailTo: string | undefined,
): Record<string, unknown> => {
	const argsTokens = inv.tokens.slice(inv.consumed)
	const out: Record<string, unknown> = {}
	const allowTail = !!tail || (typeof tailTo === 'string' && tailTo.trim().length > 0)

	const setValue = (param: DerivedParam, value: unknown) => {
		if (param.type.endsWith('[]')) {
			let arr = out[param.inputKey] as unknown[] | undefined
			if (!arr) out[param.inputKey] = arr = []
			if (Array.isArray(value)) arr.push(...value)
			else arr.push(value)
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
			if (!allowTail) {
				textParse({ reason: 'UNEXPECTED_SENTINEL', message: 'Unexpected "--": this command has no tail', at: { start: t.start, end: t.end, raw: t.raw } })
			}
			tailMode = 'explicit'
			tailTokens = argsTokens.slice(i + 1)
			break
		}

		// --no-<name>
		if (v.startsWith('--no-')) {
			const name = v.slice('--no-'.length)
			const param = paramsByLong[name]
			if (!param) {
				const suggested = suggestLongParam(name, model.params)
				textParse({
					reason: 'UNKNOWN_PARAM',
					message: `Unknown param: ${name}${suggested ? ` (did you mean --${suggested}?)` : ''}`,
					param: name,
					...(suggested ? { suggestion: suggested } : {}),
					at: { start: t.start, end: t.end, raw: t.raw },
				})
			}
			if (!param.negate) textParse({ reason: 'NEGATION_NOT_SUPPORTED', message: `Param "${name}" does not support negation`, param: name })
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
				const suggested = suggestLongParam(name, model.params)
				textParse({
					reason: 'UNKNOWN_PARAM',
					message: `Unknown param: ${name}${suggested ? ` (did you mean --${suggested}?)` : ''}`,
					param: name,
					...(suggested ? { suggestion: suggested } : {}),
					at: { start: t.start, end: t.end, raw: t.raw },
				})
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
					if (!next) textParse({ reason: 'MISSING_VALUE', message: `Missing value for --${name}`, param: name })
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
				if (!next) textParse({ reason: 'MISSING_VALUE', message: `Missing value for -${c}`, param: c })
				i++
				setValue(param, parseValue(param, next.value))
				continue
			}
			// Unknown short flag; allow negative numbers (e.g. -1) to fall through.
			if (/^[a-zA-Z]$/.test(c)) {
				textParse({ reason: 'UNKNOWN_PARAM', message: `Unknown param: -${c}`, param: c, at: { start: t.start, end: t.end, raw: t.raw } })
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
			if (!p0) textParse({ reason: 'UNKNOWN_PARAM', message: `Unknown param: -${c0}`, param: c0, at: { start: t.start, end: t.end, raw: t.raw } })
			if (p0.type === 'boolean') {
				textParse({ reason: 'INVALID_SHORT_BUNDLE', message: `Invalid short flags: ${v}`, at: { start: t.start, end: t.end, raw: t.raw } })
			}
			setValue(p0, parseValue(p0, v.slice(2)))
			continue
		}
		// -c=value
		if (/^-[a-zA-Z]=/.test(v)) {
			const c = v[1]!.toLowerCase()
			const rawVal = v.slice(3)
			const param = paramsByShort[c]
			if (!param) textParse({ reason: 'UNKNOWN_PARAM', message: `Unknown param: -${c}`, param: c, at: { start: t.start, end: t.end, raw: t.raw } })
			setValue(param, parseValue(param, rawVal))
			continue
		}
		// -cVALUE (attached value)
		if (/^-[a-zA-Z].+/.test(v) && !v.startsWith('--')) {
			const c = v[1]!.toLowerCase()
			const param = paramsByShort[c]
			if (!param) textParse({ reason: 'UNKNOWN_PARAM', message: `Unknown param: -${c}`, param: c, at: { start: t.start, end: t.end, raw: t.raw } })
			if (param.type === 'boolean') {
				textParse({ reason: 'BOOLEAN_SHORT_ATTACHED_VALUE', message: `Boolean short flag cannot take an attached value: -${c}`, param: c })
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
			// If tail is disabled, treat `key:value` / `key=value` as a keyed param attempt.
			// With tail enabled it might be intentional DSL, so we let it fall through to tail mode.
			if (!allowTail && isSafeName(name)) {
				const suggested = suggestLongParam(name, model.params)
				textParse({
					reason: 'UNKNOWN_PARAM',
					message: `Unknown param: ${name}${suggested ? ` (did you mean --${suggested}?)` : ''}`,
					param: name,
					...(suggested ? { suggestion: suggested } : {}),
					at: { start: t.start, end: t.end, raw: t.raw },
				})
			}
		}

		// Start ParseBox tail at the first non-option token.
		if (!allowTail) {
			textParse({ reason: 'UNEXPECTED_ARGUMENTS', message: 'Unexpected arguments', at: { start: t.start, end: t.end, raw: t.raw } })
		}
		tailMode = 'implicit'
		tailTokens = argsTokens.slice(i)
		break
	}

	if (tailMode) {
		if (tailMode === 'implicit' && tailTokens && tailTokens.some((tok) => isKnownKeyedToken(tok.value))) {
			textParse({
				reason: 'KEYED_PARAMS_IN_IMPLICIT_TAIL',
				message: 'Keyed params must appear before tail (use `--` to start tail explicitly)',
			})
		}

		const tailText =
			tailTokens && tailTokens.length > 0
				? typeof inv.text === 'string'
					? inv.text.slice(tailTokens[0]!.start)
					: tailTokens.map((t) => t.raw).join(' ')
				: ''

		// ParseBox tail: parse and merge an object patch.
		if (tail) {
			// ParseBox "Until" parsers intentionally fail if the end token is not present.
			// For CLI-style "tail" parsing we treat end-of-input like a newline terminator.
			const parseboxInput = tailText.endsWith('\n') ? tailText : `${tailText}\n`
			const parsed = tail.module.Parse(tail.entry as any, parseboxInput) as unknown as [] | [unknown, string]
			if (!Array.isArray(parsed) || parsed.length !== 2) {
				textParse({ reason: 'TAIL_PARSE_FAILED', message: 'Failed to parse tail' })
			}
			const [value, rest] = parsed
			if (typeof rest === 'string' && rest.trim().length > 0) {
				textParse({ reason: 'TAIL_TRAILING_INPUT', message: 'Unexpected trailing input in tail' })
			}

			if (!value || typeof value !== 'object' || Array.isArray(value)) {
				textParse({ reason: 'TAIL_INVALID_PATCH', message: 'Tail parser must return an object patch' })
			}
			for (const [k, v2] of Object.entries(value as Record<string, unknown>)) {
				if (!model.propertyKeys.has(k)) {
					textParse({ reason: 'TAIL_UNKNOWN_KEY', message: `Tail produced unknown key: ${k}`, param: k })
				}
				if (Object.prototype.hasOwnProperty.call(out, k)) {
					textParse({ reason: 'TAIL_OVERRIDE', message: `Tail cannot override param: ${k}`, param: k })
				}
				out[k] = v2
			}
		} else if (typeof tailTo === 'string' && tailTo.trim().length > 0) {
			// Raw tail: assign the remaining text into a single input key.
			const key = tailTo.trim()
			if (!model.propertyKeys.has(key)) {
				throw new CmdError('E_INTERNAL', 'Internal error', { message: `text({ tailTo }): unknown input key "${key}"` })
			}
			if (Object.prototype.hasOwnProperty.call(out, key)) {
				textParse({ reason: 'TAIL_OVERRIDE', message: `Tail cannot override param: ${key}`, param: key })
			}
			out[key] = tailText.trim()
		} else {
			throw new CmdError('E_INTERNAL', 'Internal error', { message: 'text(): missing tail configuration' })
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

export const compileTextPlan = (id: string, inputSchema: Schema, cfg: TextConfig): CompiledText => {
	const providedTriggers = cfg.triggers ? uniqueStrings(cfg.triggers) : []
	const triggers = providedTriggers.length > 0 ? providedTriggers : [id]
	const tokenizedNames = triggers.map(splitSpace).filter((x) => x.length > 0)

	if (tokenizedNames.length === 0) {
		throw new CmdError('E_INTERNAL', 'Internal error', { message: 'text(): requires at least one trigger' })
	}

	const tokenize = defaultTokenizer
	const model = deriveInputModel(inputSchema)
	const hasRootDefault = (inputSchema as any).default !== undefined
	const rootDefault = (inputSchema as any).default
	const tailTo = typeof cfg.tailTo === 'string' ? cfg.tailTo.trim() : ''
	const tail = cfg.tail

	if (tail && tailTo) {
		throw new CmdError('E_INTERNAL', 'Internal error', { message: 'text(): tail and tailTo are mutually exclusive' })
	}

	let paramsMeta: ParamSpec[] | undefined
	if (model.kind === 'object') {
		if (tailTo && !model.propertyKeys.has(tailTo)) {
			throw new CmdError('E_INTERNAL', 'Internal error', { message: `text({ tailTo }): unknown input key "${tailTo}"` })
		}
			paramsMeta = model.params.map((p) => ({
				name: p.name,
				inputKey: p.inputKey,
				type: p.type,
				...(p.description ? { description: p.description } : {}),
				...(p.required ? { required: true } : {}),
				...(p.default !== undefined ? { default: p.default } : {}),
				...(p.aliases?.length ? { aliases: p.aliases.slice() } : {}),
			...(p.short ? { short: p.short } : {}),
			...(p.negate ? { negate: true } : {}),
		}))
	} else if (tail || tailTo) {
		throw new CmdError('E_INTERNAL', 'Internal error', { message: 'text({ tail/tailTo }): only supported for object input schemas' })
	}

	const meta: ExecutableMeta = {
		triggers,
		...(paramsMeta && paramsMeta.length ? { params: paramsMeta } : {}),
		...(tail || tailTo ? { tail: true } : {}),
		...(tailTo ? { tailTo } : {}),
	}

	return {
		meta,
		tokenize,
		match: (tokens) => matchAnyName(tokenizedNames, tokens),
		parseCandidate: (inv) => {
			const argsTokens = inv.tokens.slice(inv.consumed)
		if (model.kind === 'emptyObject') {
			if (argsTokens.length > 0) textParse({ reason: 'NO_ARGUMENTS', message: 'This command takes no arguments' })
			return {}
		}
			if (model.kind === 'string') {
				if (argsTokens.length === 0 && hasRootDefault) return rootDefault
				return argsTokens.map((t) => t.value).join(' ')
			}
		if (model.kind === 'number') {
			if (argsTokens.length === 0) {
				if (hasRootDefault) return rootDefault
				textParse({ reason: 'MISSING_ARGUMENT', message: 'Missing number' })
			}
			if (argsTokens.length > 1) textParse({ reason: 'TOO_MANY_ARGUMENTS', message: 'Too many arguments' })
			const n = Number(argsTokens[0]!.value)
			if (!Number.isFinite(n)) textParse({ reason: 'INVALID_NUMBER', message: 'Invalid number' })
			if (model.integer && !Number.isInteger(n)) textParse({ reason: 'EXPECTED_INTEGER', message: 'Expected integer' })
			return n
		}
		if (model.kind === 'boolean') {
			if (argsTokens.length === 0) {
				if (hasRootDefault) return rootDefault
				textParse({ reason: 'MISSING_ARGUMENT', message: 'Missing boolean' })
			}
			if (argsTokens.length > 1) textParse({ reason: 'TOO_MANY_ARGUMENTS', message: 'Too many arguments' })
			const b = parseBoolean(argsTokens[0]!.value)
			if (b === null) textParse({ reason: 'INVALID_BOOLEAN', message: 'Invalid boolean' })
			return b
		}
			return parseObjectArgs(model, inv, tail, tailTo || undefined)
		},
	}
}
