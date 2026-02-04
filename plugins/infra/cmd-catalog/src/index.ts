import type {
	CmdDoc,
	CmdDocSource,
	DocContext,
	ExecCtx,
	Executable,
	McpMeta,
	Result,
	Router,
} from '@pluxel/cmd'
import {
	createRouter,
	isExecutable,
	isMcpExecutable,
	isTextExecutable,
	resolveDoc,
	resolveText,
} from '@pluxel/cmd'

import {
	buildCmdPermCatalog,
	cmdPermLocal,
	cmdPermNode,
	deriveGroupFromLocalId,
	normalizeLocalId,
	type PermissionDecl,
} from './permissions'

export type CatalogPerm = false | true | { local?: string }

export type CatalogEntry<E extends Executable<any, any> = Executable<any, any>> = {
	exec: E
	/** Command id as authored (typically localId). */
	id: string
	/** Optional permission node string (namespace-prefixed). */
	permNode?: string
	/** Optional permission local node string (no namespace). */
	permLocal?: string
	/** Derived group from `id` (dot-prefix). */
	group?: string
}

export type McpToolDescriptor = {
	name: string
	title: string
	description: string
	inputSchema: Record<string, unknown>
	outputSchema?: Record<string, unknown>
	exec: Executable<any, any> & { mcp: McpMeta }
}

export type CmdCatalog = {
	readonly nsKey?: string
	register(exec: Executable<any, any>, opts?: { perm?: CatalogPerm }): void
	registerAll(exportsObj: Record<string, unknown>, opts?: { perm?: CatalogPerm }): void
	list(): CatalogEntry[]
	/**
	 * Returns a router with all registered text executables set().
	 * Non-text executables are ignored.
	 */
	router(cfg?: { caseInsensitive?: boolean }): Router
	/**
	 * Resolve MCP tool descriptors (data-only).
	 * Upstream decides how/where to register these tools.
	 */
	mcpTools(ctx?: DocContext): McpToolDescriptor[]
	/**
	 * Build a permission declaration catalog (data-only), using the bot-suite-compatible local convention:
	 * - exact: `cmd.<localId>`
	 * - stars: `cmd.*` and `cmd.<group>.*`
	 */
	permissionCatalog(opts?: {
		defaultEffect?: 'allow' | 'deny'
		includeStars?: boolean
	}): { nsKey: string; decls: PermissionDecl[] } | null
}

const resolveMcpText = (src: unknown, ctx: DocContext): string => {
	if (typeof src === 'string') return src
	if (typeof src === 'function') return resolveText(src as any, ctx)
	return ''
}

export function createCmdCatalog(opts?: { nsKey?: string }): CmdCatalog {
	const nsKey = opts?.nsKey ? String(opts.nsKey).trim() : undefined
	const entries = new Map<string, CatalogEntry>()

	const upsert = (exec: Executable<any, any>, perm: CatalogPerm | undefined) => {
		const id = String(exec.id ?? '').trim()
		if (!id) throw new Error('[cmd-catalog] executable.id must be non-empty')

		const localId = normalizeLocalId(id)
		const group = deriveGroupFromLocalId(localId)

		let permLocal: string | undefined
		if (perm !== false) {
			const local =
				perm === true || perm === undefined
					? cmdPermLocal(localId)
					: typeof perm === 'object' && perm.local
						? String(perm.local).trim()
						: cmdPermLocal(localId)
			if (local) permLocal = local
		}

		const permNode = nsKey && permLocal ? cmdPermNode(nsKey, permLocal) : undefined

		entries.set(id, {
			exec,
			id,
			...(permNode ? { permNode } : {}),
			...(permLocal ? { permLocal } : {}),
			...(group ? { group } : {}),
		})
	}

	return {
		nsKey,
		register(exec, opts) {
			upsert(exec, opts?.perm)
		},
		registerAll(exportsObj, opts) {
			for (const v of Object.values(exportsObj ?? {})) {
				if (!isExecutable(v)) continue
				upsert(v, opts?.perm)
			}
		},
		list() {
			return Array.from(entries.values()).sort((a, b) => a.id.localeCompare(b.id))
		},
		router(cfg) {
			const r = createRouter<ExecCtx>({ caseInsensitive: !!cfg?.caseInsensitive })
			for (const e of entries.values()) {
				if (!isTextExecutable(e.exec)) continue
				r.set(e.exec as any)
			}
			return r
		},
		mcpTools(ctx) {
			const docCtx: DocContext = ctx ?? {}
			const out: McpToolDescriptor[] = []
			for (const e of entries.values()) {
				if (!isMcpExecutable(e.exec)) continue
				const meta = e.exec.mcp!
				out.push({
					name: String(meta.name),
					title: resolveMcpText(meta.title, docCtx),
					description: resolveMcpText(meta.description, docCtx),
					inputSchema: meta.inputSchema as any,
					...(meta.outputSchema ? { outputSchema: meta.outputSchema as any } : {}),
					exec: e.exec as any,
				})
			}
			out.sort((a, b) => a.name.localeCompare(b.name))
			return out
		},
		permissionCatalog(opts) {
			if (!nsKey) return null
			const ids = Array.from(entries.values())
				.map((e) => e.id)
				.filter(Boolean)
			const { exact, stars } = buildCmdPermCatalog(ids, {
				defaultEffect: opts?.defaultEffect ?? 'deny',
				includeStars: opts?.includeStars,
			})
			return { nsKey, decls: [...stars, ...exact] }
		},
	}
}

export type { CmdDoc, CmdDocSource, DocContext, ExecCtx, Executable, Result, Router }
export { isExecutable, isMcpExecutable, isTextExecutable, resolveDoc }
