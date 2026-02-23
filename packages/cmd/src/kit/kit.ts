import { cmd } from '../cmd'
import type { CmdBuilder, TextConfig, TextExecutable } from '../cmd'
import type { ExecCtx } from '../core'
import type { McpConfig } from '../mcp'

import type { CmdExt, CommandRegistry, RegisteredCommandInfo } from '../registry'

import type { BuiltCommandDraft, BuiltOpDraft } from './draft'
import type { CommandDef, CommandDefInput } from './define'
import { normalizeDefs } from './define'
import type { KitWithOptions, OpSpec, TextCommandSpec } from './spec'
import { applyPrefix, deriveGroupFromTokens, normalizeRoute } from './route'

type DecorateResult<I, O, S extends { hasHandle: boolean; hasText: boolean; hasMcp: boolean }, Ext extends CmdExt> = {
	builder?: CmdBuilder<I, O, S>
	info?: Partial<RegisteredCommandInfo<Ext>>
}

export type CommandKit<C extends ExecCtx = ExecCtx, Ext extends CmdExt = CmdExt> = {
	with(opts: KitWithOptions): CommandKit<C, Ext>
	with(opts: KitWithOptions, fn: (kit: CommandKit<C, Ext>) => void): void

	list(): Array<
		{
			id: string
			scopeKey: string | null
			mcpName: string | null
		} & RegisteredCommandInfo<Ext>
	>

	help(group?: string): string

	install(...defs: readonly CommandDefInput<C, Ext>[]): void
}

type CreateKitOptions<C extends ExecCtx, Ext extends CmdExt> = {
	/** Logical scope key (used for trigger conflict resolution + default id/mcp naming). */
	scopeKey: string
	/** Stable executable id generator. Default: `${scopeKey}.${kind}:${tokens.join('/')}` */
	idOf?: (kind: 'cmd' | 'op', tokens: readonly string[]) => string
	/** Default MCP tool name. Default: `${scopeKey}.${tokens.join('.')}` (sanitized). */
	mcpNameOf?: (tokens: readonly string[]) => string
	/**
	 * Optional decorator for applying product-specific behavior:
	 * - extra interceptors (permissions, rates, tracing)
	 * - info enrichment (perm node, internal flags, etc)
	 */
	decorate?: <I, O, S extends { hasHandle: boolean; hasText: boolean; hasMcp: boolean }>(args: {
		kind: 'cmd' | 'op'
		tokens: readonly string[]
		execId: string
		spec: TextCommandSpec<Ext> | OpSpec<Ext>
		builder: CmdBuilder<I, O, S>
		info: RegisteredCommandInfo<Ext>
	}) => DecorateResult<I, O, S, Ext> | void
}

const uniqueStrings = (xs: readonly string[]) => {
	const out: string[] = []
	const seen = new Set<string>()
	for (const x of xs) {
		const s = String(x).trim()
		if (!s) continue
		if (seen.has(s)) continue
		seen.add(s)
		out.push(s)
	}
	return out
}

const sanitizeMcpName = (s: string) => {
	const raw = String(s ?? '').trim()
	if (!raw) return ''
	return raw
		.replace(/\s+/g, '_')
		.replace(/[^a-zA-Z0-9_.-]/g, '_')
		.replace(/_+/g, '_')
		.replace(/^_+|_+$/g, '')
}

export function createCommandKit<C extends ExecCtx, Ext extends CmdExt = CmdExt>(
	registry: CommandRegistry<C, Ext>,
	opts: CreateKitOptions<C, Ext>,
): CommandKit<C, Ext> {
	const scopeKey = String(opts.scopeKey ?? '').trim()
	if (!scopeKey) throw new Error('[cmdkit] createCommandKit(): missing scopeKey')

	const idOf = opts.idOf ?? ((kind, tokens) => `${scopeKey}.${kind}:${tokens.join('/')}`)
	const mcpNameOf =
		opts.mcpNameOf ??
		((tokens) => {
			const base = tokens.map((t) => sanitizeMcpName(t)).filter(Boolean).join('.')
			return base ? `${scopeKey}.${base}` : scopeKey
		})

	const decorate = opts.decorate

	const mergeTags = (base: readonly string[] | undefined, extra: readonly string[] | undefined) => {
		if (!base?.length && !extra?.length) return undefined
		return uniqueStrings([...(base ?? []), ...(extra ?? [])])
	}

	const makeKit = (state: { group?: string; tags?: readonly string[]; prefixTokens?: readonly string[] }): CommandKit<C, Ext> => {
		const group = state.group
		const tags = state.tags ? uniqueStrings(state.tags) : undefined
		const prefixTokens = state.prefixTokens ?? []

		const applyDecorate = <I, O, S extends { hasHandle: boolean; hasText: boolean; hasMcp: boolean }>(
			args: Parameters<NonNullable<typeof decorate>>[0] & { builder: CmdBuilder<I, O, S>; info: RegisteredCommandInfo<Ext> },
		): { builder: CmdBuilder<I, O, S>; info: RegisteredCommandInfo<Ext> } => {
			if (!decorate) return { builder: args.builder, info: args.info }
			const res = decorate(args)
			return {
				builder: (res && res.builder ? (res.builder as any) : args.builder) as any,
				info: { ...args.info, ...(res && res.info ? res.info : {}) },
			}
		}

		const registerOp = <R,>(spec: OpSpec<Ext>, built: BuiltOpDraft<C, R>) => {
			if (spec.enabled === false) return

			const main = normalizeRoute(spec.name, 'op.name')
			const tokens = applyPrefix(prefixTokens, main.tokens)
			const execId = idOf('op', tokens)
			const internal = Boolean(spec.doc.internal)

			let b: CmdBuilder<any, any, any> = cmd(execId) as any
			b = b.doc(spec.doc)
			const applied = built.apply(b)
			b = applied.builder as any

			const effectiveTags = mergeTags(tags, spec.tags)
			const info: RegisteredCommandInfo<Ext> = {
				tokens: [...tokens],
				primary: tokens.join(' '),
				triggers: [tokens.join(' ')],
				title: spec.doc.title,
				description: spec.doc.description,
				...(spec.doc.usage ? { usage: spec.doc.usage } : {}),
				group: spec.group ?? group ?? deriveGroupFromTokens(tokens),
				...(effectiveTags?.length ? { tags: effectiveTags as any } : {}),
				...(spec.ext && Object.keys(spec.ext as any).length ? { ext: { ...(spec.ext as any) } } : {}),
				...(internal ? { internal: true } : {}),
			}

			const decorated = applyDecorate({
				kind: 'op',
				tokens,
				execId,
				spec,
				builder: b,
				info,
			})

			let builder = decorated.builder as any
			if (!internal && spec.mcp !== false) {
				const m0: McpConfig = (spec.mcp ?? {}) as any
				const title = String(spec.doc.title ?? '').trim() || tokens.join(' ')
				const m: McpConfig = {
					...m0,
					...(m0.name ? {} : { name: mcpNameOf(tokens) }),
					...(m0.title ? {} : { title }),
					...(m0.description ? {} : { description: spec.doc.description }),
				}
				builder = builder.mcp(m)
			}

			registry.registerOp(builder.build(), scopeKey)
		}

		const registerCommand = <R,>(spec: TextCommandSpec<Ext>, built: BuiltCommandDraft<C, R>) => {
			if (spec.enabled === false) return

			const main = normalizeRoute(spec.name, 'command.name')
			const tokens = applyPrefix(prefixTokens, main.tokens)
			const execId = idOf('cmd', tokens)
			const internal = Boolean(spec.doc.internal)

			const aliasRoutes = (spec.aliases ?? []).map((a, i) => normalizeRoute(a, `command.aliases[${i}]`))
			const triggers = uniqueStrings([tokens.join(' '), ...aliasRoutes.map((a) => applyPrefix(prefixTokens, a.tokens).join(' '))])
			if (!triggers.length) throw new Error(`[cmdkit] command("${execId}") requires at least one trigger`)

			let b: CmdBuilder<any, any, any> = cmd(execId) as any
			b = b.doc(spec.doc)
			const applied = built.apply(b)
			b = applied.builder as any

			const effectiveTags = mergeTags(tags, spec.tags)
			const info: RegisteredCommandInfo<Ext> = {
				tokens: [...tokens],
				primary: triggers[0]!,
				triggers: [...triggers],
				title: spec.doc.title,
				description: spec.doc.description,
				...(spec.doc.usage ? { usage: spec.doc.usage } : {}),
				group: spec.group ?? group ?? deriveGroupFromTokens(tokens),
				...(effectiveTags?.length ? { tags: effectiveTags as any } : {}),
				...(spec.ext && Object.keys(spec.ext as any).length ? { ext: { ...(spec.ext as any) } } : {}),
				...(internal ? { internal: true } : {}),
				...(spec.tailUsage ? { tailUsage: spec.tailUsage } : {}),
				...(spec.tailKeys?.length ? { tailKeys: spec.tailKeys.slice() } : {}),
			}

			const decorated = applyDecorate({
				kind: 'cmd',
				tokens,
				execId,
				spec,
				builder: b,
				info,
			})

			let builder = decorated.builder as any
			if (!internal && spec.mcp !== false) {
				const m0: McpConfig = (spec.mcp ?? {}) as any
				const title = String(spec.doc.title ?? '').trim() || triggers[0]!
				const m: McpConfig = {
					...m0,
					...(m0.name ? {} : { name: mcpNameOf(tokens) }),
					...(m0.title ? {} : { title }),
					...(m0.description ? {} : { description: spec.doc.description }),
				}
				builder = builder.mcp(m)
			}

			const partialTextCfg = applied.text as Omit<TextConfig, 'triggers'> | undefined
			const textCfg: TextConfig = {
				triggers,
				...(partialTextCfg ? partialTextCfg : {}),
			}

			const exec = builder.text(textCfg).build() as TextExecutable<any, any>

			registry.registerTextCommand(exec, scopeKey, decorated.info)
		}

		const withFn = ((opts: KitWithOptions, fn?: (kit: CommandKit<C, Ext>) => void) => {
			const pfx = String(opts.prefix ?? '').trim()
			const prefixAppend = pfx ? normalizeRoute(pfx, 'with.prefix').tokens : []
			const derived = makeKit({
				group: opts.group ?? group,
				tags: mergeTags(tags, opts.tags),
				prefixTokens: [...prefixTokens, ...prefixAppend],
			})
			if (typeof fn === 'function') {
				fn(derived)
				return
			}
			return derived
		}) as CommandKit<C, Ext>['with']

		const out: CommandKit<C, Ext> = {
			with: withFn,

			list() {
				const out: Array<
					{
						id: string
						scopeKey: string | null
						mcpName: string | null
					} & RegisteredCommandInfo<Ext>
				> = []
				for (const { id, scopeKey, info } of registry.list()) {
					out.push({
						id,
						scopeKey,
						mcpName: registry.getMcpName(id),
						...info,
						tokens: info.tokens.slice(),
						triggers: info.triggers.slice(),
						...(info.tags ? { tags: info.tags.slice() } : {}),
						...(info.ext ? { ext: { ...(info.ext as any) } } : {}),
						...(info.tailKeys ? { tailKeys: info.tailKeys.slice() } : {}),
					})
				}
				out.sort((a, b) => a.primary.localeCompare(b.primary))
				return out
			},

			help(arg?: string) {
				const groupArg = String(arg ?? '').trim()
				const list = this.list().filter((c) => !groupArg || (c.group ?? '').toLowerCase() === groupArg.toLowerCase())
				if (list.length === 0) return ''
				const lines: string[] = []
				for (const c of list) {
					const head = c.usage ?? c.primary
					const desc = c.description ? ` — ${c.description}` : ''
					lines.push(`- ${head}${desc}`)
				}
				return lines.join('\n')
			},

			install(...inputs: readonly CommandDefInput<C, Ext>[]) {
				const walk = (kit: CommandKit<C, Ext>, def: CommandDef<C, Ext>) => {
					if (def.kind === 'group') {
						kit.with(def.with).install(def.items)
						return
					}
					if (def.kind === 'command') {
						registerCommand(def.spec, def.built as any)
						return
					}
					if (def.kind === 'op') {
						registerOp(def.spec, def.built as any)
						return
					}
					const _exhaustive: never = def
					throw new Error(`[cmdkit] install(): unknown def kind`)
				}

				for (const def of normalizeDefs<C, Ext>(...inputs)) walk(out, def)
			},
		}

		return out
	}

	return makeKit({})
}
