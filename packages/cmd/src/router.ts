import { CmdError, normalizeError } from './core'
import type { ExecCtx } from './core'
import type { Result } from './result'
import { createErr } from './result'
import type { CmdDocSource } from './doc'
import type { ParamSpec } from './text'
import { CMDKIT_TEXT_RUNNER, type TextRunner } from './text-runner'
import { defaultTokenizer, type TextToken } from './tokenize'
import { splitSpace } from './internal/strings'

export interface RouterHelpIndexResult {
	/** Debug/introspection only (rendering belongs to upstream). */
	list: Array<{ id: string; trigger: string }>
}

export interface RouterHelpCommandResult {
	/** Matched command by id or trigger. */
	id: string
	triggers: string[]
	params?: ParamSpec[]
	tail?: true
	/** Present when the command uses `text({ tailTo })`. */
	tailTo?: string
	doc?: CmdDocSource
}

export type RouterEntry = {
	id: string
	triggers: string[]
}

export type RouterIssue =
	| { kind: 'DUPLICATE_ID'; id: string }
	| { kind: 'MISSING_TRIGGERS'; id: string }
	| { kind: 'DUPLICATE_TRIGGER'; id: string; trigger: string }
	| { kind: 'CONFLICTING_TRIGGER'; id: string; trigger: string; existingId: string }

export type TextRoutable<Ctx extends ExecCtx = ExecCtx> = {
	id: string
		/**
		 * Required: router is text-first; non-text executables must not be registered.
		 *
		 * Note: @pluxel/cmd-built executables also carry an internal token-aware runner,
		 * but a plain `execText(text)` is sufficient.
		 */
	execText: (text: string, ctx?: Ctx) => Promise<Result<unknown, CmdError>>
	/** Optional internal runner that can consume already-tokenized input. */
	[CMDKIT_TEXT_RUNNER]?: TextRunner<Ctx>
	/** Optional, but required unless `opts.triggers` is provided to add()/set(). */
	meta?: { triggers: string[] }
}

export type RouterMatch = {
	id: string
	consumed: number
	/** Matched trigger string (canonical, space-joined). */
	trigger: string
	tokens: TextToken[]
	restTokens: TextToken[]
	text?: string
}

export interface Router<Ctx extends ExecCtx = ExecCtx> {
	/** Expose the router's tokenizer so upstream can share the exact tokenization behavior. */
	tokenize(text: string): TextToken[]
	/** Validate an add/upsert operation without mutating router state. */
	check(
		exec: { id: string; meta?: { triggers: string[] } },
		opts?: { triggers: string[] },
		ignoreId?: string,
	): { ok: true } | { ok: false; issues: RouterIssue[] }

	add(exec: TextRoutable<Ctx>, opts?: { triggers: string[] }): void
	/** Add multiple executables atomically (all-or-nothing). */
	addMany(execs: Array<TextRoutable<Ctx>>): void
	/** Upsert by id (remove old entry, then add). */
	set(exec: TextRoutable<Ctx>, opts?: { triggers: string[] }): void
	/** Upsert multiple executables atomically (all-or-nothing). */
	setMany(execs: Array<TextRoutable<Ctx>>): void
	remove(id: string): void
	has(id: string): boolean
	get(id: string): { id: string; triggers: string[]; exec: TextRoutable<Ctx> } | undefined
	list(): RouterEntry[]
	match(text: string): RouterMatch | null
	matchTokens(tokens: TextToken[]): RouterMatch | null
	dispatchMatch(match: RouterMatch, ctx?: Ctx): Promise<Result<unknown, CmdError>>
	dispatch(text: string, ctx?: Ctx): Promise<Result<unknown, CmdError>>
	dispatchTokens(tokens: TextToken[], ctx?: Ctx): Promise<Result<unknown, CmdError>>
	helpIndex(): RouterHelpIndexResult
	helpCommand(name: string): RouterHelpCommandResult | undefined
}

export function createRouter<Ctx extends ExecCtx = ExecCtx>(cfg?: { caseInsensitive?: boolean; maxTextLength?: number }): Router<Ctx> {
	const tokenize = defaultTokenizer
	const norm = (s: string) => (cfg?.caseInsensitive ? s.toLowerCase() : s)
	const maxTextLength = typeof cfg?.maxTextLength === 'number' ? cfg.maxTextLength : 16 * 1024

	type Node = { exec?: any; consumed?: number; trigger?: string; next: Map<string, Node> }
	const root: Node = { next: new Map() }

	const entries = new Map<string, { exec: TextRoutable<Ctx>; triggers: string[]; tokenized: Array<readonly string[]> }>()
	const flatNames = new Map<string, string>() // normalized trigger -> exec.id

	const canonTrigger = (raw: string) => splitSpace(raw).join(' ')
	const keyOfTrigger = (raw: string) => norm(canonTrigger(raw))
	const normalizeTriggers = (src: unknown) => (src as unknown[] | undefined)?.map(String).map(canonTrigger).filter(Boolean) ?? []

	const put = (tokens: readonly string[], exec: TextRoutable<Ctx>) => {
		let cur = root
		for (const raw of tokens) {
			const t = norm(raw)
			let next = cur.next.get(t)
			if (!next) cur.next.set(t, (next = { next: new Map() }))
			cur = next
		}
		if (cur.exec && cur.exec !== exec) {
			throw new CmdError('E_INTERNAL', 'Internal error', {
				message: `Command name conflict: "${tokens.join(' ')}" already registered by "${cur.exec.id}"`,
			})
		}
		cur.exec = exec
		cur.consumed = tokens.length
		cur.trigger = tokens.join(' ')
	}

	const del = (tokens: readonly string[], exec: TextRoutable<Ctx>) => {
		const stack: Array<{ node: Node; token: string }> = []
		let cur: Node | undefined = root
		for (const raw of tokens) {
			if (!cur) return
			const t = norm(raw)
			stack.push({ node: cur, token: t })
			cur = cur.next.get(t)
		}
		if (!cur) return
		if (cur.exec !== exec) return
		delete cur.exec
		delete cur.consumed
		delete cur.trigger

		// Prune empty nodes bottom-up.
		for (let i = stack.length - 1; i >= 0; i--) {
			const parent = stack[i]!.node
			const token = stack[i]!.token
			const child = parent.next.get(token)
			if (!child) continue
			if (child.exec || child.next.size > 0) break
			parent.next.delete(token)
		}
	}

	const findLongestTokens = (tokens: TextToken[]) => {
		let cur = root
		let best: { exec: any; consumed: number; trigger: string } | undefined
		for (let i = 0; i < tokens.length; i++) {
			const t = norm(tokens[i]!.value)
			const next = cur.next.get(t)
			if (!next) break
			cur = next
			if (cur.exec && cur.trigger) best = { exec: cur.exec, consumed: cur.consumed ?? (i + 1), trigger: cur.trigger }
		}
		return best
	}

	const dispatchMatched = async (match: { exec: any; consumed: number }, tokens: TextToken[], text: string | undefined, ctx?: Ctx) => {
		const exec = match.exec as TextRoutable<Ctx>
		const runner: TextRunner<Ctx> | undefined = (exec as any)[CMDKIT_TEXT_RUNNER]
		if (runner) return await runner({ tokens, consumed: match.consumed, ...(text !== undefined ? { text } : {}) }, ctx)
		// Prefer the original string when available to preserve whitespace exactly.
		if (text !== undefined) return await exec.execText(text, ctx)
		// Otherwise reconstruct from tokens; prefer `raw` to preserve quotes/escapes.
		return await exec.execText(tokens.map((t) => t.raw).join(' '), ctx)
	}

	return {
		tokenize,

		check(exec, opts, ignoreId) {
			const id = String(exec.id ?? '').trim()
			const triggers = normalizeTriggers(opts?.triggers ?? exec.meta?.triggers)

			const issues: RouterIssue[] = []
			if (!triggers.length) issues.push({ kind: 'MISSING_TRIGGERS', id })

			if (ignoreId !== id && entries.has(id)) {
				issues.push({ kind: 'DUPLICATE_ID', id })
			}

			const seen = new Set<string>()
			for (const raw of triggers) {
				if (seen.has(raw)) {
					issues.push({ kind: 'DUPLICATE_TRIGGER', id, trigger: raw })
					continue
				}
				seen.add(raw)
				const key = keyOfTrigger(raw)
				const existingId = flatNames.get(key)
				if (existingId && existingId !== id && existingId !== ignoreId) {
					issues.push({ kind: 'CONFLICTING_TRIGGER', id, trigger: raw, existingId })
				}
			}

			return issues.length ? { ok: false as const, issues } : { ok: true as const }
		},

		add(exec, opts) {
			const checked = this.check(exec, opts)
			if (!checked.ok) {
				throw new CmdError('E_INTERNAL', 'Internal error', {
					message: `router.add("${exec.id}") rejected`,
					details: { issues: checked.issues },
				})
			}

			const list = normalizeTriggers(opts?.triggers ?? exec.meta?.triggers)
			const tokenized = list.map(splitSpace).filter((x) => x.length > 0)
			entries.set(exec.id, { exec, triggers: list, tokenized })
			for (const t of tokenized) put(t, exec)
			for (const name of list) flatNames.set(keyOfTrigger(name), exec.id)
		},

		addMany(execs) {
			const issues: RouterIssue[] = []

			const seenIds = new Set<string>()
			const seenKeys = new Map<string, string>() // normalized trigger -> id

			// Seed with existing triggers.
			for (const [id, e] of entries.entries()) {
				for (const name of e.triggers) {
					seenKeys.set(keyOfTrigger(name), id)
				}
			}

			for (const exec of execs) {
				const id = String(exec.id ?? '').trim()
				const triggers = normalizeTriggers(exec.meta?.triggers)

				if (!id) continue
				if (seenIds.has(id)) issues.push({ kind: 'DUPLICATE_ID', id })
				seenIds.add(id)

				if (!triggers.length) {
					issues.push({ kind: 'MISSING_TRIGGERS', id })
					continue
				}

				const localSeen = new Set<string>()
				for (const raw of triggers) {
					if (localSeen.has(raw)) {
						issues.push({ kind: 'DUPLICATE_TRIGGER', id, trigger: raw })
						continue
					}
					localSeen.add(raw)

					const key = keyOfTrigger(raw)
					const existingId = seenKeys.get(key)
					if (existingId && existingId !== id) {
						issues.push({ kind: 'CONFLICTING_TRIGGER', id, trigger: raw, existingId })
						continue
					}
					seenKeys.set(key, id)
				}
			}

			if (issues.length) {
				throw new CmdError('E_INTERNAL', 'Internal error', {
					message: `router.addMany(...) rejected`,
					details: { issues },
				})
			}

			for (const exec of execs) this.add(exec)
		},

		set(exec, opts) {
			// Pre-check to keep set() atomic: do not remove the existing entry when the upsert is invalid.
			const checked = this.check(exec, opts, exec.id)
			if (!checked.ok) {
				throw new CmdError('E_INTERNAL', 'Internal error', {
					message: `router.set("${exec.id}") rejected`,
					details: { issues: checked.issues },
				})
			}

			this.remove(exec.id)
			this.add(exec, opts)
		},

		setMany(execs) {
			const issues: RouterIssue[] = []

			const replaceIds = new Set<string>(execs.map((e) => String(e.id ?? '').trim()).filter(Boolean))

			// Seed with existing triggers excluding replaced ids.
			const seenKeys = new Map<string, string>() // normalized trigger -> id
			for (const [id, e] of entries.entries()) {
				if (replaceIds.has(id)) continue
				for (const name of e.triggers) {
					seenKeys.set(keyOfTrigger(name), id)
				}
			}

			// Validate incoming (also catches duplicates within the batch).
			const seenIds = new Set<string>()
			for (const exec of execs) {
				const id = String(exec.id ?? '').trim()
				const triggers = normalizeTriggers(exec.meta?.triggers)

				if (!id) continue
				if (seenIds.has(id)) issues.push({ kind: 'DUPLICATE_ID', id })
				seenIds.add(id)

				if (!triggers.length) {
					issues.push({ kind: 'MISSING_TRIGGERS', id })
					continue
				}

				const localSeen = new Set<string>()
				for (const raw of triggers) {
					if (localSeen.has(raw)) {
						issues.push({ kind: 'DUPLICATE_TRIGGER', id, trigger: raw })
						continue
					}
					localSeen.add(raw)

					const key = keyOfTrigger(raw)
					const existingId = seenKeys.get(key)
					if (existingId && existingId !== id) {
						issues.push({ kind: 'CONFLICTING_TRIGGER', id, trigger: raw, existingId })
						continue
					}
					seenKeys.set(key, id)
				}
			}

			if (issues.length) {
				throw new CmdError('E_INTERNAL', 'Internal error', {
					message: `router.setMany(...) rejected`,
					details: { issues },
				})
			}

			for (const exec of execs) this.set(exec)
		},

		remove(id) {
			const entry = entries.get(id)
			if (!entry) return
			entries.delete(id)
			for (const t of entry.tokenized) del(t, entry.exec)
			for (const name of entry.triggers) {
				const k = keyOfTrigger(name)
				if (flatNames.get(k) === id) flatNames.delete(k)
			}
		},

		has(id) {
			return entries.has(id)
		},

		get(id) {
			const e = entries.get(id)
			if (!e) return undefined
			return { id, triggers: e.triggers.slice(), exec: e.exec as TextRoutable<Ctx> }
		},

		list() {
			return Array.from(entries.entries())
				.map(([id, e]) => ({ id, triggers: e.triggers.slice() }))
				.sort((a, b) => a.id.localeCompare(b.id))
		},

		match(text) {
			if (maxTextLength > 0 && text.length > maxTextLength) return null
			const tokens = tokenize(text)
			const match = findLongestTokens(tokens)
			if (!match) return null
			return { id: match.exec.id as string, consumed: match.consumed, trigger: match.trigger, tokens, restTokens: tokens.slice(match.consumed), text }
		},

		matchTokens(tokens) {
			const match = findLongestTokens(tokens)
			if (!match) return null
			return { id: match.exec.id as string, consumed: match.consumed, trigger: match.trigger, tokens, restTokens: tokens.slice(match.consumed) }
		},

		async dispatch(text, ctx) {
			try {
				if (maxTextLength > 0 && text.length > maxTextLength) {
					return createErr(new CmdError('E_TEXT_PARSE', 'Invalid command text', { details: { reason: 'TEXT_TOO_LONG' } }))
				}
				const tokens = tokenize(text)
				const match = findLongestTokens(tokens)
				if (!match) return createErr(new CmdError('E_CMD_NOT_FOUND', 'Unknown command', { details: { text } }))
				return await dispatchMatched(match, tokens, text, ctx)
			} catch (e) {
				return createErr(normalizeError(ctx, e, 'E_INTERNAL', 'Failed to dispatch'))
			}
		},

		async dispatchMatch(match, ctx) {
			try {
				const entry = entries.get(match.id)
				if (!entry) {
					return createErr(
						new CmdError('E_CMD_NOT_FOUND', 'Unknown command', {
							details: { tokens: match.tokens.map((t) => t.value), text: match.text },
						}),
					)
				}
				return await dispatchMatched({ exec: entry.exec, consumed: match.consumed }, match.tokens, match.text, ctx)
			} catch (e) {
				return createErr(normalizeError(ctx, e, 'E_INTERNAL', 'Failed to dispatch'))
			}
		},

		async dispatchTokens(tokens, ctx) {
			try {
				const match = findLongestTokens(tokens)
				if (!match) return createErr(new CmdError('E_CMD_NOT_FOUND', 'Unknown command', { details: { text: tokens.map((t) => t.value).join(' ') } }))
				return await dispatchMatched(match, tokens, undefined, ctx)
			} catch (e) {
				return createErr(normalizeError(ctx, e, 'E_INTERNAL', 'Failed to dispatch'))
			}
		},

		helpIndex() {
			const list = Array.from(entries.values())
				.flatMap((e) => e.triggers.map((trigger) => ({ id: e.exec.id as string, trigger })))
				.sort((a, b) => a.trigger.localeCompare(b.trigger))

			return { list }
		},

		helpCommand(name) {
			const raw = String(name ?? '').trim()
			if (!raw) return undefined

			const byId = entries.get(raw)
				if (byId) {
					return {
						id: byId.exec.id as string,
						triggers: byId.triggers.slice(),
						...(Array.isArray((byId.exec as any)?.meta?.params) ? { params: (byId.exec as any).meta.params as ParamSpec[] } : {}),
						...((byId.exec as any)?.meta?.tail ? { tail: true } : {}),
						...(typeof (byId.exec as any)?.meta?.tailTo === 'string' ? { tailTo: (byId.exec as any).meta.tailTo as string } : {}),
						...((byId.exec as any).doc ? { doc: (byId.exec as any).doc as CmdDocSource } : {}),
					}
				}

			const byTriggerId = flatNames.get(keyOfTrigger(raw))
			const byTrigger = byTriggerId ? entries.get(byTriggerId) : undefined
			if (!byTrigger) return undefined

			return {
				id: byTrigger.exec.id as string,
				triggers: byTrigger.triggers.slice(),
				...(Array.isArray((byTrigger.exec as any)?.meta?.params) ? { params: (byTrigger.exec as any).meta.params as ParamSpec[] } : {}),
				...((byTrigger.exec as any)?.meta?.tail ? { tail: true } : {}),
				...(typeof (byTrigger.exec as any)?.meta?.tailTo === 'string' ? { tailTo: (byTrigger.exec as any).meta.tailTo as string } : {}),
				...((byTrigger.exec as any).doc ? { doc: (byTrigger.exec as any).doc as CmdDocSource } : {}),
			}
		},
	}
}
