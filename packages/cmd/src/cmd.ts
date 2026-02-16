import type { CustomValidator, ExecCtx, Infer, Interceptor, Schema, StrictEmptyObject, ValidationSpec } from './core'
import { CmdError, STRICT_EMPTY_OBJECT_SCHEMA, createValidationSpec, normalizeError } from './core'
import { CMDKIT_TEXT_RUNNER, type TextInvocation } from './text-runner'

import type { CmdDocSource } from './doc'
import { mergeDocSources, resolveDoc } from './doc'
import type { McpConfig, McpMeta } from './mcp'
import { compileMcpMeta } from './mcp'
import type { ExecutableMeta, TextConfig } from './text'
import { compileTextPlan } from './text'
import { compileInterceptors, execPlanResult, type ExecSpec } from './exec'
import type { Result } from './result'
import { createErr } from './result'

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
		if (cfg.description !== undefined) {
			return compileMcpMeta(spec.id, spec.input.schema, spec.output?.schema, cfg)
		}

		if (!spec.doc) {
			return compileMcpMeta(spec.id, spec.input.schema, spec.output?.schema, cfg)
		}

		return compileMcpMeta(spec.id, spec.input.schema, spec.output?.schema, {
			...cfg,
			description: (ctx) => resolveDoc(spec.doc, ctx)?.description ?? spec.id,
		} satisfies McpConfig)
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
	output<T extends Schema>(schema: T): CmdBuilder<I, Infer<T>, S>

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
	text(cfg?: TextConfig): CmdBuilder<I, O, { hasHandle: S['hasHandle']; hasText: true; hasMcp: S['hasMcp'] }>

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
		output(schema: any) {
			const outputCustom = (spec.outputCustom ?? []) as Array<CustomValidator<any>>
			const next = createValidationSpec(schema as Schema) as ValidationSpec<any>
			next.custom = outputCustom.slice()
			return builder<I, any, S>({ ...spec, output: next })
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
		doc(doc: CmdDocSource) {
			return builder<I, O, S>({ ...spec, doc: mergeDocSources(spec.doc, doc) })
		},
		mcp(cfg?: McpConfig) {
			return builder<I, O, any>({ ...spec, mcp: cfg ?? {} })
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
			return builder<I, O, any>({ ...spec, text: { ...(triggers ? { triggers } : {}), ...(tail ? { tail } : {}) } })
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
