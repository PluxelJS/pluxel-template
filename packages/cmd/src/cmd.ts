import type { CustomValidator, ExecCtx, Infer, Interceptor, Schema, StrictEmptyObject, ValidationSpec } from './core'
import { CmdError, STRICT_EMPTY_OBJECT_SCHEMA, createValidationSpec, normalizeError } from './core'
import { CMDKIT_TEXT_RUNNER, type TextInvocation } from './text-runner'

import type { CmdDocSource } from './doc'
import { mergeDocSources, resolveDoc, resolveText } from './doc'
import type { McpConfig, McpMeta } from './mcp'
import { compileMcpMeta } from './mcp'
import type { ExecutableMeta, TextConfig } from './text'
import { compileTextPlan } from './text'
import { compileInterceptors, execPlanResult, type ExecSpec } from './exec'
import type { Result } from './result'
import { createErr } from './result'
import type { ObjectOptions, TProperties, TObject } from '@sinclair/typebox'
import { obj, openObj } from './typebox'

export { CmdError } from './core'
export type { CmdErrorCode } from './core'

export type { CmdDoc, CmdDocSource, DocContext, DocProvider, DocTextProvider, DocTextSource } from './doc'
export { resolveDoc, resolveText } from './doc'

export type { McpConfig, McpMeta } from './mcp'
export type { McpToolDef } from './mcp'
export { resolveMcpToolDef } from './mcp'

export type { ExecutableMeta, ParamSpec, TextConfig } from './text'
export type { Err, Ok, Result } from './result'
export { ResultOperator, createErr, createOk, expectErr, expectOk, isErr, isOk, unwrapErr, unwrapOk } from './result'

export interface Executable<I, O> {
	readonly id: string
	/** Optional human doc (shared by text + MCP/tool). */
	readonly doc?: CmdDocSource
	/**
	 * Optional MCP opt-in metadata.
	 *
	 * When present, upstream can register this executable as an MCP tool.
	 */
	readonly mcp?: McpMeta
	/** Raw input schema (TypeBox/JSON Schema). */
	readonly inputSchema: Schema
	/** Raw output schema (TypeBox/JSON Schema), if any. */
	readonly outputSchema?: Schema
	readonly meta?: ExecutableMeta
	exec(value: unknown, ctx?: ExecCtx): Promise<Result<O, CmdError>>
	execText?: (text: string, ctx?: ExecCtx) => Promise<Result<O, CmdError>>
}

export type TextExecutable<I, O> = Executable<I, O> & {
	execText: (text: string, ctx?: ExecCtx) => Promise<Result<O, CmdError>>
	meta: ExecutableMeta
}

export type McpExecutable<I, O> = Executable<I, O> & {
	mcp: McpMeta
}

export type Op<I, O> = Executable<I, O>
export type TextOp<I, O> = TextExecutable<I, O>
export type McpOp<I, O> = McpExecutable<I, O>
export type TextMcpOp<I, O> = TextExecutable<I, O> & McpExecutable<I, O>

export function isTextExecutable<I, O>(exec: Executable<I, O>): exec is TextExecutable<I, O> {
	return typeof exec.execText === 'function'
}

export function isMcpExecutable<I, O>(exec: Executable<I, O>): exec is McpExecutable<I, O> {
	return !!exec.mcp
}

export type AnyExecutable = Executable<any, any>

/**
 * Runtime guard for filtering unknown module exports.
 *
 * This intentionally checks only the stable public surface:
 * - `id: string`
 * - `exec(value, ctx?): Promise<Result<...>>`
 */
export function isExecutable(x: unknown): x is AnyExecutable {
	if (!x || typeof x !== 'object') return false
	return typeof (x as any).id === 'string' && typeof (x as any).exec === 'function'
}

type State = { hasHandle: boolean; hasText: boolean; hasMcp: boolean }

type BuilderSpec = ExecSpec & {
	doc?: CmdDocSource
	mcp?: McpConfig
	text?: TextConfig
	inputCustom?: Array<CustomValidator<any>>
	outputCustom?: Array<CustomValidator<any>>
}

function makeExecutable<I, O>(spec: BuilderSpec): Executable<I, O> {
	const compiled = compileInterceptors(spec.interceptors)

	const execFn = async (value: unknown, ctx?: ExecCtx) =>
		await execPlanResult<I, O>(spec, compiled, value, ctx)

	const compileMcp = () => {
		if (!spec.mcp) return undefined

		const cfg = spec.mcp ?? {}
		if (!spec.doc) return compileMcpMeta(spec.id, spec.input.schema, spec.output?.schema, cfg)

		const seeded: McpConfig = {
			...cfg,
			...(cfg.title !== undefined
				? {}
				: {
						title: (ctx) => resolveDoc(spec.doc, ctx)?.title ?? spec.id,
					}),
			...(cfg.description !== undefined
				? {}
				: {
						description: (ctx) => {
							const d = resolveDoc(spec.doc, ctx)
							return d?.description ?? d?.title ?? spec.id
						},
					}),
		}

		return compileMcpMeta(spec.id, spec.input.schema, spec.output?.schema, seeded)
	}

	const mcp = compileMcp()

	const executable: Executable<I, O> = {
		id: spec.id,
		...(spec.doc ? { doc: spec.doc } : {}),
		...(mcp ? { mcp } : {}),
		inputSchema: spec.input.schema,
		...(spec.output ? { outputSchema: spec.output.schema } : {}),
		exec: execFn,
	}

	if (spec.text) {
		// Compile text plan at build time from the final input schema.
		const compiledText = compileTextPlan(spec.id, spec.input.schema, spec.text)
		;(executable as any).meta = compiledText.meta

		const runner = async (inv: TextInvocation, ctx?: ExecCtx): Promise<Result<O, CmdError>> => {
			try {
				const candidate = compiledText.parseCandidate(inv)

				return await execPlanResult<I, O>(spec, compiled, candidate, ctx)
			} catch (e) {
				return createErr(normalizeError(ctx, e, 'E_INTERNAL', 'Command failed'))
			}
		}

		;(executable as any)[CMDKIT_TEXT_RUNNER] = runner

		executable.execText = async (text: string, ctx?: ExecCtx) => {
			try {
				const tokens = compiledText.tokenize(text)
				const m = compiledText.match(tokens)
				if (!m) {
					return createErr(
						new CmdError('E_TEXT_PARSE', 'Invalid text', { message: `Text does not match any trigger for "${spec.id}"` }),
					)
				}
				return await runner({ text, tokens, consumed: m.consumed }, ctx)
			} catch (e) {
				return createErr(normalizeError(ctx, e, 'E_INTERNAL', 'Command failed'))
			}
		}
	}

	return executable
}

export interface CmdBuilder<I, O, S extends State> {
	input<T extends Schema>(schema: T): CmdBuilder<Infer<T>, O, S>
	inputObj<P extends TProperties>(
		properties: P,
		options?: Omit<ObjectOptions, 'additionalProperties'> & { additionalProperties?: boolean },
	): CmdBuilder<Infer<TObject<P>>, O, S>
	inputOpenObj<P extends TProperties>(properties: P, options?: Omit<ObjectOptions, 'additionalProperties'>): CmdBuilder<Infer<TObject<P>>, O, S>

	output<T extends Schema>(schema: T): CmdBuilder<I, Infer<T>, S>
	outputObj<P extends TProperties>(
		properties: P,
		options?: Omit<ObjectOptions, 'additionalProperties'> & { additionalProperties?: boolean },
	): CmdBuilder<I, Infer<TObject<P>>, S>
	outputOpenObj<P extends TProperties>(properties: P, options?: Omit<ObjectOptions, 'additionalProperties'>): CmdBuilder<I, Infer<TObject<P>>, S>

	/**
	 * Extra input validation beyond JSON Schema (server-only constraints, cross-field checks, etc).
	 *
	 * All custom validators are executed and their issues are aggregated into a single `E_INPUT_VALIDATION`.
	 */
	validateInput(...fns: Array<CustomValidator<I>>): CmdBuilder<I, O, S>

	/**
	 * Extra output validation beyond JSON Schema.
	 *
	 * All custom validators are executed and their issues are aggregated into a single `E_OUTPUT_VALIDATION`.
	 */
	validateOutput(...fns: Array<CustomValidator<O>>): CmdBuilder<I, O, S>

	/**
	 * Sugar: set `doc.title`.
	 *
	 * For locale-aware titles, use `doc((ctx) => ({ title: ... }))`.
	 */
	title(title: string): CmdBuilder<I, O, S>
	/**
	 * Sugar: set `doc.description`.
	 *
	 * For locale-aware descriptions, use `doc((ctx) => ({ description: ... }))`.
	 */
	describe(description: string): CmdBuilder<I, O, S>
	/** Sugar: set `doc.details`. */
	details(details: string): CmdBuilder<I, O, S>
	/** Sugar: set `doc.usage`. */
	usage(usage: string): CmdBuilder<I, O, S>
	/** Sugar: set `doc.examples`. */
	examples(...examples: string[]): CmdBuilder<I, O, S>
	/** Sugar: set `doc.internal`. */
	internal(internal?: boolean): CmdBuilder<I, O, S>

	doc(doc: CmdDocSource): CmdBuilder<I, O, S>
	/** Explicitly opt-in to exposing this executable as an MCP tool. */
	mcp(cfg?: McpConfig): CmdBuilder<I, O, { hasHandle: S['hasHandle']; hasText: S['hasText']; hasMcp: true }>
	intercept<TState>(itc: Interceptor<TState>): CmdBuilder<I, O, S>

	handle(
		fn: (input: I, ctx: ExecCtx) => O | Promise<O>,
	): CmdBuilder<I, O, { hasHandle: true; hasText: S['hasText']; hasMcp: S['hasMcp'] }>
	/**
	 * Enable text execution for this command.
	 *
	 * If `cfg.triggers` is omitted, defaults to `[id]`.
	 */
	text<TInput = I>(cfg?: TextConfig<TInput>): CmdBuilder<I, O, { hasHandle: S['hasHandle']; hasText: true; hasMcp: S['hasMcp'] }>

	build(this: CmdBuilder<I, O, { hasHandle: true; hasText: S['hasText']; hasMcp: S['hasMcp'] }>): Executable<I, O> &
		(S['hasText'] extends true ? { execText: (text: string, ctx?: ExecCtx) => Promise<Result<O, CmdError>>; meta: ExecutableMeta } : {}) &
		(S['hasMcp'] extends true ? { mcp: McpMeta } : {})
}

function builder<I, O, S extends State>(spec: BuilderSpec): CmdBuilder<I, O, S> {
	const api: CmdBuilder<I, O, S> = {
		input(schema: any) {
			const inputCustom = (spec.inputCustom ?? []) as Array<CustomValidator<any>>
			const next = createValidationSpec(schema as Schema) as ValidationSpec<any>
			next.custom = inputCustom.slice()
			return builder<any, O, S>({ ...spec, input: next })
		},
		inputObj(properties: any, options?: any) {
			return (api as any).input(obj(properties, options))
		},
		inputOpenObj(properties: any, options?: any) {
			return (api as any).input(openObj(properties, options))
		},
		output(schema: any) {
			const outputCustom = (spec.outputCustom ?? []) as Array<CustomValidator<any>>
			const next = createValidationSpec(schema as Schema) as ValidationSpec<any>
			next.custom = outputCustom.slice()
			return builder<I, any, S>({ ...spec, output: next })
		},
		outputObj(properties: any, options?: any) {
			return (api as any).output(obj(properties, options))
		},
		outputOpenObj(properties: any, options?: any) {
			return (api as any).output(openObj(properties, options))
		},
		validateInput(...fns: any[]) {
			if (!fns.length) return builder<I, O, S>(spec)
			const inputCustom = [...(spec.inputCustom ?? []), ...fns] as Array<CustomValidator<any>>
			const input = { ...spec.input, custom: inputCustom.slice() }
			return builder<I, O, S>({ ...spec, inputCustom, input })
		},
		validateOutput(...fns: any[]) {
			if (!fns.length) return builder<I, O, S>(spec)
			const outputCustom = [...(spec.outputCustom ?? []), ...fns] as Array<CustomValidator<any>>
			const output = spec.output ? { ...spec.output, custom: outputCustom.slice() } : spec.output
			return builder<I, O, S>({ ...spec, outputCustom, ...(output ? { output } : {}) })
		},
		title(title: string) {
			return (api as any).doc({ title: String(title ?? '').trim() })
		},
		describe(description: string) {
			return (api as any).doc({ description: String(description ?? '').trim() })
		},
		details(details: string) {
			return (api as any).doc({ details: String(details ?? '').trim() })
		},
		usage(usage: string) {
			return (api as any).doc({ usage: String(usage ?? '').trim() })
		},
		examples(...examples: string[]) {
			const list = examples.map((x) => String(x ?? '').trim()).filter(Boolean)
			return list.length ? (api as any).doc({ examples: list }) : builder<I, O, S>(spec)
		},
		internal(internal?: boolean) {
			return (api as any).doc({ internal: internal === undefined ? true : Boolean(internal) })
		},
		doc(doc: CmdDocSource) {
			return builder<I, O, S>({ ...spec, doc: mergeDocSources(spec.doc, doc) })
		},
		mcp(cfg?: McpConfig) {
			const nextMcp = cfg ?? {}
			const seededDoc: CmdDocSource | undefined =
				spec.doc
					? undefined
					: nextMcp.title !== undefined || nextMcp.description !== undefined
						? (ctx) => ({
								...(nextMcp.title !== undefined ? { title: resolveText(nextMcp.title, ctx) } : {}),
								...(nextMcp.description !== undefined ? { description: resolveText(nextMcp.description, ctx) } : {}),
							})
						: undefined

			return builder<I, O, any>({
				...spec,
				mcp: nextMcp,
				...(seededDoc ? { doc: mergeDocSources(spec.doc, seededDoc) } : {}),
			})
		},
		intercept(itc: any) {
			return builder<I, O, S>({ ...spec, interceptors: [...spec.interceptors, itc] })
		},
		handle(fn: any) {
			return builder<I, O, any>({ ...spec, handle: fn })
		},
		text(cfg?: TextConfig) {
			const triggers = Array.isArray(cfg?.triggers) ? cfg!.triggers.slice() : undefined
			const tail = cfg?.tail
			const tailTo = typeof cfg?.tailTo === 'string' ? cfg!.tailTo : undefined
			return builder<I, O, any>({
				...spec,
				text: { ...(triggers ? { triggers } : {}), ...(tail ? { tail } : {}), ...(tailTo ? { tailTo } : {}) },
			})
		},
		build() {
			return makeExecutable<I, O>(spec) as any
		},
	}
	return api
}

export function cmd(id: string): CmdBuilder<StrictEmptyObject, unknown, { hasHandle: false; hasText: false; hasMcp: false }> {
	const trimmed = String(id).trim()
	if (!trimmed) {
		throw new CmdError('E_INTERNAL', 'Internal error', { message: 'cmd(id): id must be non-empty' })
	}
	const spec: BuilderSpec = {
		id: trimmed,
		input: createValidationSpec(STRICT_EMPTY_OBJECT_SCHEMA),
		interceptors: [],
	}
	return builder<any, any, any>(spec) as any
}

/**
 * MCP-first convenience: create a cmd builder with MCP enabled.
 *
 * This is sugar for `cmd(id).mcp(cfg)`.
 */
export function tool(
	id: string,
	cfg?: McpConfig,
): CmdBuilder<StrictEmptyObject, unknown, { hasHandle: false; hasText: false; hasMcp: true }> {
	return cmd(id).mcp(cfg) as any
}
