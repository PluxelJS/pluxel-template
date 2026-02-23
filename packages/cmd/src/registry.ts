import { toJsonSchema } from './core'
import type { ExecCtx } from './core'
import type { Executable, McpExecutable, McpMeta, TextExecutable } from './cmd'
import { isMcpExecutable, isTextExecutable } from './cmd'
import type { ParamSpec } from './text'
import type { Router } from './router'
import { createRouter } from './router'

import { normalizeRoute } from './kit/route'

export type CmdExt = Record<string, unknown>

export type RegisteredCommandInfo<Ext extends CmdExt = CmdExt> = {
	/** Primary route tokens, e.g. ["meme","list"]. */
	tokens: string[]
	/** Canonical primary trigger, e.g. "meme list". */
	primary: string
	/** All triggers (primary + aliases), canonicalized. */
	triggers: string[]
	/** Optional short title for UI/help. */
	title?: string
	/** Optional tags for help/UI filtering. */
	tags?: string[]
	/**
	 * Optional downstream metadata bag.
	 *
	 * This is not interpreted by @pluxel/cmd; products can attach stable metadata here
	 * (e.g. permission node, rate limit key) so UIs/RPC can render a single unified list.
	 */
	ext?: Ext
	/** Derived keyed params for flags completion/help. */
	params?: ParamSpec[]
	/** Derived enum-like choices for params (when available). */
	paramChoices?: Record<string, string[]>
	/** Whether this command accepts a ParseBox tail. */
	tail?: true
	/** Optional tail placeholder (used for usage derivation). Example: `<query>` or `<expr>`. */
	tailUsage?: string
	/** Optional input keys populated by tail (used to hide redundant `--<key>` flags). */
	tailKeys?: string[]
	/** Optional usage string (not parsed). */
	usage?: string
	/** Optional human description. */
	description?: string
	/** Optional group label for UI/help. */
	group?: string
	/** Internal/dev command marker (UI may hide by default). */
	internal?: true
}

type WarnFn = (msg: string, meta?: unknown) => void

export class CommandRegistry<C extends ExecCtx = ExecCtx, Ext extends CmdExt = CmdExt> {
	private readonly router: Router<C>
	private readonly caseInsensitive: boolean
	private readonly warn?: WarnFn

	private readonly idsByScope = new Map<string, Set<string>>()
	private readonly scopeById = new Map<string, string>()
	private readonly infoById = new Map<string, RegisteredCommandInfo<Ext>>()
	private readonly mcpById = new Map<string, McpMeta>()
	private readonly textTriggerToId = new Map<string, string>()
	private readonly textTriggerKeysById = new Map<string, string[]>()

	constructor(options?: { caseInsensitive?: boolean; warn?: WarnFn }) {
		this.caseInsensitive = options?.caseInsensitive ?? true
		this.router = createRouter<C>({ caseInsensitive: this.caseInsensitive })
		this.warn = options?.warn
	}

	/** Tokenize command text using the registry's router tokenizer. */
	tokenize(text: string) {
		return this.router.tokenize(text)
	}

	/** Match a text input against registered text command triggers. */
	match(text: string) {
		return this.router.match(text)
	}

	/** Dispatch a text input (command line) to the matched executable. */
	dispatch(text: string, ctx?: C) {
		return this.router.dispatch(text, ctx)
	}

	/** Dispatch an already-tokenized input. */
	dispatchTokens(tokens: Parameters<Router<C>['dispatchTokens']>[0], ctx?: C) {
		return this.router.dispatchTokens(tokens, ctx)
	}

	helpIndex() {
		return this.router.helpIndex()
	}

	helpCommand(name: string) {
		return this.router.helpCommand(name)
	}

	private triggerKey(trigger: string): string {
		const t = String(trigger).trim()
		return this.caseInsensitive ? t.toLowerCase() : t
	}

	private sanitizeScopeToken(scopeKey: string): string {
		const raw = String(scopeKey ?? '').trim()
		if (!raw) return 'scope'
		return raw
			.replace(/\s+/g, '_')
			.replace(/[.:/]/g, '_')
			.replace(/_+/g, '_')
			.replace(/^_+|_+$/g, '') || 'scope'
	}

	private resolveTextTriggersForRegistration(
		id: string,
		scopeKey: string,
		triggers: readonly string[],
	): { triggers: string[]; conflicts: Array<{ trigger: string; existingId: string; resolved: string }> } {
		const base = triggers.map(String).map((s) => s.trim()).filter(Boolean)
		const unique = Array.from(new Set(base))
		const prefix = this.sanitizeScopeToken(scopeKey)

		const out: string[] = []
		const conflicts: Array<{ trigger: string; existingId: string; resolved: string }> = []

		for (const t of unique) {
			const key = this.triggerKey(t)
			const existing = this.textTriggerToId.get(key)
			if (!existing || existing === id) {
				out.push(t)
				continue
			}

			let n = 1
			let resolved = `${prefix} ${t}`
			while (true) {
				const k2 = this.triggerKey(resolved)
				const ex2 = this.textTriggerToId.get(k2)
				if (!ex2 || ex2 === id) break
				n += 1
				resolved = `${prefix}${n} ${t}`
			}

			normalizeRoute(resolved, 'command.trigger.resolved')

			conflicts.push({ trigger: t, existingId: existing, resolved })
			out.push(resolved)
		}

		const final = Array.from(new Set(out.map((s) => s.trim()).filter(Boolean)))
		return { triggers: final, conflicts }
	}

	private reserveTextTriggers(id: string, triggers: readonly string[]) {
		const nextKeys = Array.from(new Set(triggers.map((t) => this.triggerKey(t)).filter(Boolean)))

		const prevKeys = this.textTriggerKeysById.get(id) ?? []
		for (const k of prevKeys) {
			if (this.textTriggerToId.get(k) === id) this.textTriggerToId.delete(k)
		}

		for (const k of nextKeys) {
			const existing = this.textTriggerToId.get(k)
			if (existing && existing !== id) {
				throw new Error(`[cmdkit] invariant: trigger "${k}" already reserved by "${existing}" (trying "${id}")`)
			}
		}

		this.textTriggerKeysById.set(id, nextKeys)
		for (const k of nextKeys) this.textTriggerToId.set(k, id)
	}

	private releaseTextTriggers(id: string) {
		const prevKeys = this.textTriggerKeysById.get(id)
		if (!prevKeys?.length) return
		for (const k of prevKeys) {
			if (this.textTriggerToId.get(k) === id) this.textTriggerToId.delete(k)
		}
		this.textTriggerKeysById.delete(id)
	}

	registerTextCommand(exec: TextExecutable<any, any>, scopeKey: string, info: RegisteredCommandInfo<Ext>): void {
		if (!scopeKey) throw new Error('[cmdkit] command registration requires scopeKey')

		const resolved = this.resolveTextTriggersForRegistration(exec.id, scopeKey, info.triggers)
		if (resolved.conflicts.length) {
			this.warn?.('command trigger conflict(s) detected; auto-prefixed with scopeKey', {
				id: exec.id,
				scopeKey,
				conflicts: resolved.conflicts,
			})
		}

		this.remove(exec.id)
		this.router.add(exec as any, { triggers: resolved.triggers })

		this.reserveTextTriggers(exec.id, resolved.triggers)
		const rawParams = Array.isArray((exec as any)?.meta?.params) ? (((exec as any).meta.params as ParamSpec[]).slice()) : undefined
		const params = filterTailParams(rawParams, info.tailKeys)
		const tail = (exec as any)?.meta?.tail ? true : undefined
		const paramChoices = params?.length ? deriveParamChoices(exec, params) : undefined
		const primary = resolved.triggers[0] ?? info.primary
		const tailOptional = tail ? inferTailOptional(rawParams, info.tailKeys) : false
		const usage = normalizeUsageOverride(primary, info.usage) ?? deriveUsage(primary, params, tail, info.tailUsage, tailOptional)

		this.infoById.set(exec.id, {
			...info,
			triggers: resolved.triggers,
			primary,
			usage,
			...(params?.length ? { params } : {}),
			...(paramChoices ? { paramChoices } : {}),
			...(tail ? { tail: true } : {}),
		})

		this.track(scopeKey, exec.id)

		if (isMcpExecutable(exec)) this.mcpById.set(exec.id, exec.mcp)
	}

	registerOp(exec: Executable<any, any>, scopeKey: string): void {
		if (!scopeKey) throw new Error('[cmdkit] command registration requires scopeKey')

		this.remove(exec.id)
		this.track(scopeKey, exec.id)

		if (isMcpExecutable(exec)) this.mcpById.set(exec.id, exec.mcp)
	}

	registerMcpTool(exec: McpExecutable<any, any>, scopeKey: string): void {
		if (!scopeKey) throw new Error('[cmdkit] command registration requires scopeKey')

		this.remove(exec.id)
		this.track(scopeKey, exec.id)
		this.mcpById.set(exec.id, exec.mcp)
	}

	add(exec: Executable<any, any>, scopeKey: string): void {
		if (isTextExecutable(exec)) {
			const triggers =
				Array.isArray((exec as any)?.meta?.triggers) && (exec as any).meta.triggers.length
					? (exec as any).meta.triggers.slice()
					: [exec.id]
			const primary = String(triggers[0] ?? '').trim()
			const tokens = primary
				? normalizeRoute(primary, 'registry.add(text).primary').tokens
				: normalizeRoute(exec.id, 'registry.add(text).id').tokens
			this.registerTextCommand(exec, scopeKey, { tokens, primary: primary || tokens.join(' '), triggers } as any)
			return
		}
		if (isMcpExecutable(exec)) this.registerMcpTool(exec, scopeKey)
		else this.registerOp(exec, scopeKey)
	}

	getMcpName(id: string): string | null {
		const meta = this.mcpById.get(id) as any
		const name = typeof meta?.name === 'string' ? meta.name.trim() : ''
		return name || null
	}

	list(): Array<{ id: string; scopeKey: string | null; info: RegisteredCommandInfo<Ext> }> {
		return Array.from(this.infoById.entries()).map(([id, info]) => ({ id, scopeKey: this.scopeById.get(id) ?? null, info }))
	}

	listMcpTools(): Array<{ id: string; mcp: McpMeta }> {
		return Array.from(this.mcpById.entries()).map(([id, mcp]) => ({ id, mcp }))
	}

	remove(id: string): void {
		this.infoById.delete(id)
		this.mcpById.delete(id)
		const scopeKey = this.scopeById.get(id)
		this.scopeById.delete(id)
		this.releaseTextTriggers(id)
		try {
			this.router.remove(id)
		} catch {
			// ignore
		}
		if (scopeKey) this.untrack(scopeKey, id)
	}

	cleanupCommandsForScope(scopeKey: string): void {
		const bucket = this.idsByScope.get(scopeKey)
		if (!bucket || bucket.size === 0) return
		for (const id of Array.from(bucket)) this.remove(id)
		this.idsByScope.delete(scopeKey)
	}

	private track(scopeKey: string, id: string): void {
		let bucket = this.idsByScope.get(scopeKey)
		if (!bucket) {
			bucket = new Set()
			this.idsByScope.set(scopeKey, bucket)
		}
		bucket.add(id)
		this.scopeById.set(id, scopeKey)
	}

	private untrack(scopeKey: string, id: string): void {
		const bucket = this.idsByScope.get(scopeKey)
		if (!bucket) return
		bucket.delete(id)
		if (bucket.size === 0) this.idsByScope.delete(scopeKey)
	}
}

function deriveParamChoices(exec: TextExecutable<any, any>, params: readonly ParamSpec[]): Record<string, string[]> | undefined {
	try {
		const js = toJsonSchema(exec.inputSchema) as any
		const props = js?.type === 'object' && js?.properties && typeof js.properties === 'object' ? (js.properties as Record<string, any>) : null
		if (!props) return undefined

		const out: Record<string, string[]> = {}

		for (const p of params) {
			if (p.type !== 'string') continue
			const keys = uniqueStrings([p.name, ...(p.aliases ?? [])])
			let propSchema: any = null
			for (const k of keys) {
				if (Object.prototype.hasOwnProperty.call(props, k)) {
					propSchema = props[k]
					break
				}
			}
			if (!propSchema || typeof propSchema !== 'object') continue
			const choices = pickStringChoices(propSchema)
			if (!choices?.length) continue
			out[p.name] = choices
		}

		return Object.keys(out).length ? out : undefined
	} catch {
		return undefined
	}
}

function normalizeUsageOverride(primary: string, usage: string | undefined): string | undefined {
	const p = String(primary ?? '').trim()
	const u = String(usage ?? '').trim()
	if (!u) return undefined
	if (!p) return u
	if (u === p) return u
	if (u.startsWith(`${p} `)) return u
	return `${p} ${u}`
}

function filterTailParams(params: readonly ParamSpec[] | undefined, tailKeys: readonly string[] | undefined): ParamSpec[] | undefined {
	if (!params?.length) return undefined
	if (!tailKeys?.length) return params.slice()

	const hidden = new Set<string>()
	for (const k of tailKeys) {
		const name = deriveParamNameFromKey(k)
		if (name) hidden.add(name)
	}
	if (hidden.size === 0) return params.slice()

	return params.filter((p) => !hidden.has(p.name))
}

const isSafeName = (s: string) => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s)

const sanitizeName = (key: string) =>
	String(key ?? '')
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

function deriveParamNameFromKey(inputKey: string): string {
	const key = String(inputKey ?? '').trim()
	if (!key) return ''
	const base = isSafeName(key) ? key : sanitizeName(key)
	if (!isSafeName(base)) return ''
	return toKebabCase(base)
}

function inferTailOptional(params: readonly ParamSpec[] | undefined, tailKeys: readonly string[] | undefined): boolean {
	if (!params?.length) return false
	if (!tailKeys?.length) return false

	for (const k of tailKeys) {
		const name = deriveParamNameFromKey(k)
		if (!name) return false
		const p = params.find((x) => x.name === name)
		if (!p) return false
		if (p.required) return false
	}
	return true
}

function deriveUsage(
	primary: string,
	params: readonly ParamSpec[] | undefined,
	tail: true | undefined,
	tailUsage: string | undefined,
	tailOptional: boolean,
): string {
	const head = String(primary ?? '').trim()
	const parts: string[] = []
	if (head) parts.push(head)

	const sortedParams = params?.length
		? params
				.slice()
				.sort((a, b) => Number(Boolean(b.required)) - Number(Boolean(a.required)) || a.name.localeCompare(b.name))
		: []

	for (const p of sortedParams) parts.push(formatParamUsage(p))

	if (tail) {
		const rawPlaceholder = String(tailUsage ?? '').trim() || '<tail>'
		const placeholder = tailOptional ? `[${rawPlaceholder}]` : rawPlaceholder
		const needsSeparator = sortedParams.length > 0
		if (needsSeparator) parts.push('--', placeholder)
		else parts.push(placeholder)
	}

	return parts.join(' ').trim()
}

function formatParamUsage(p: ParamSpec): string {
	const name = String(p?.name ?? '').trim()
	const isBool = p.type === 'boolean' || p.type === 'boolean[]'
	const isArray = String(p.type).endsWith('[]')

	const typeLabel = (() => {
		if (isBool) return ''
		if (p.type === 'string') return '<string>'
		if (p.type === 'number') return '<number>'
		if (p.type === 'json') return '<json>'
		if (p.type === 'string[]') return '<string,...>'
		if (p.type === 'number[]') return '<number,...>'
		if (p.type === 'json[]') return '<json,...>'
		if (p.type === 'boolean[]') return ''
		return isArray ? '<value,...>' : '<value>'
	})()

	const flag = name ? `--${name}` : '--param'
	const body = isBool ? flag : `${flag} ${typeLabel}`.trim()
	return p.required ? body : `[${body}]`
}

function pickStringChoices(schema: any): string[] | undefined {
	const seen = new Set<string>()
	const out: string[] = []

	const push = (v: unknown) => {
		if (typeof v !== 'string') return
		if (!v.trim()) return
		if (seen.has(v)) return
		seen.add(v)
		out.push(v)
	}

	if (Array.isArray(schema.enum)) for (const v of schema.enum) push(v)

	const pickFrom = (xs: unknown) => {
		if (!Array.isArray(xs)) return
		for (const item of xs) {
			if (!item || typeof item !== 'object') continue
			if ('const' in (item as any)) push((item as any).const)
		}
	}

	pickFrom(schema.anyOf)
	pickFrom(schema.oneOf)

	if ('const' in schema) push(schema.const)

	return out.length ? out : undefined
}

function uniqueStrings(xs: readonly string[]): string[] {
	const out: string[] = []
	const seen = new Set<string>()
	for (const x of xs) {
		const s = String(x ?? '').trim()
		if (!s) continue
		if (seen.has(s)) continue
		seen.add(s)
		out.push(s)
	}
	return out
}
