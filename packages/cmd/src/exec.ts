import type { AnyStdSchema, BeforeResult, ExecCtx, Interceptor } from './core'
import { CmdError, normalizeError, nowMs, throwIfStopped, validateSchema, withSpan } from './core'
import type { CmdErrorCode } from './core'
import { CMD_EVENT } from './events'
import type { Result } from './result'
import { createErr, createOk } from './result'

export type AnyFn = (...args: any[]) => any

export type ExecSpec = {
	id: string
	input: AnyStdSchema
	output?: AnyStdSchema
	interceptors: ReadonlyArray<Interceptor<any>>
	handle?: AnyFn
}

const EMPTY_CTX: ExecCtx = Object.freeze({}) as ExecCtx

type CompiledInterceptors = {
	count: number
	before: Array<{ idx: number; fn: NonNullable<Interceptor<any>['before']> }>
	afterInput: Array<{ idx: number; fn: NonNullable<Interceptor<any>['afterInput']> }>
	afterOutputRev: Array<{ idx: number; fn: NonNullable<Interceptor<any>['afterOutput']> }>
	onErrorRev: Array<{ idx: number; fn: NonNullable<Interceptor<any>['onError']>; canRecover: boolean }>
	finallyRev: Array<{ idx: number; fn: NonNullable<Interceptor<any>['finally']> }>
}

export const compileInterceptors = (interceptors: ReadonlyArray<Interceptor<any>>): CompiledInterceptors => {
	const before: CompiledInterceptors['before'] = []
	const afterInput: CompiledInterceptors['afterInput'] = []
	const afterOutputRev: CompiledInterceptors['afterOutputRev'] = []
	const onErrorRev: CompiledInterceptors['onErrorRev'] = []
	const finallyRev: CompiledInterceptors['finallyRev'] = []

	for (let idx = 0; idx < interceptors.length; idx++) {
		const itc = interceptors[idx]!
		if (itc.before) before.push({ idx, fn: itc.before })
		if (itc.afterInput) afterInput.push({ idx, fn: itc.afterInput })
		if (itc.afterOutput) afterOutputRev.push({ idx, fn: itc.afterOutput })
		if (itc.onError) onErrorRev.push({ idx, fn: itc.onError, canRecover: !!itc.canRecover })
		if (itc.finally) finallyRev.push({ idx, fn: itc.finally })
	}

	afterOutputRev.reverse()
	onErrorRev.reverse()
	finallyRev.reverse()

	return { count: interceptors.length, before, afterInput, afterOutputRev, onErrorRev, finallyRev }
}

const runInterceptorsFinally = async (
	compiled: CompiledInterceptors,
	states: readonly unknown[],
	summary: { ok: boolean; durationMs: number; err?: CmdError },
	ctx: ExecCtx,
) => {
	for (const it of compiled.finallyRev) {
		const state = states[it.idx]
		try {
			await it.fn(ctx, summary, state)
		} catch {
			// Swallow finally errors: do not mask the original outcome.
		}
	}
}

const asBeforeResult = <S,>(res: unknown): BeforeResult<S> => (res ?? { kind: 'continue' }) as any

const reportFaultOnce = async (
	ctx: ExecCtx,
	id: string,
	fault: CmdError,
	attrs: { durationMs: number; recovered: boolean },
	state: { reported: boolean },
) => {
	if (state.reported) return
	if (fault.kind !== 'fault') return
	state.reported = true

	ctx.emit?.(CMD_EVENT.EXEC_FAULT, { id, code: fault.code, durationMs: attrs.durationMs, recovered: attrs.recovered })

	try {
		await ctx.onFault?.({ id, err: fault, durationMs: attrs.durationMs, recovered: attrs.recovered })
	} catch {
		// Swallow onFault errors.
	}
}

const validateWithEvents = async <S extends AnyStdSchema>(
	id: string,
	schema: S,
	value: unknown,
	kind: 'input' | 'output',
	ctx: ExecCtx,
): Promise<any> => {
	const startEvt = kind === 'input' ? CMD_EVENT.SCHEMA_INPUT_START : CMD_EVENT.SCHEMA_OUTPUT_START
	const okEvt = kind === 'input' ? CMD_EVENT.SCHEMA_INPUT_OK : CMD_EVENT.SCHEMA_OUTPUT_OK
	const failEvt = kind === 'input' ? CMD_EVENT.SCHEMA_INPUT_FAIL : CMD_EVENT.SCHEMA_OUTPUT_FAIL
	const code = kind === 'input' ? ('E_INPUT_VALIDATION' as const) : ('E_OUTPUT_VALIDATION' as const)

	ctx.emit?.(startEvt, { id })
	try {
		const out = await validateSchema(schema, value, code, ctx)
		ctx.emit?.(okEvt, { id })
		return out
	} catch (e) {
		const err = normalizeError(ctx, e, 'E_INTERNAL', 'Command failed')
		if (err.code === code) {
			const issues = (err.details as any)?.issues
			ctx.emit?.(failEvt, { id, issues: Array.isArray(issues) ? issues.length : undefined })
		}
		throw err
	}
}

export const execPlan = async <I, O>(
	spec: ExecSpec,
	compiled: CompiledInterceptors,
	candidate: unknown,
	ctx?: ExecCtx,
): Promise<O> => {
	const c = ctx ?? EMPTY_CTX
	const id = spec.id
	const inputSchema = spec.input
	const outputSchema = spec.output

	const start = nowMs(c)
	c.emit?.(CMD_EVENT.EXEC_START, { id, atMs: start })

	const states: unknown[] = new Array(compiled.count)
	let ok = false
	let finalErr: CmdError | undefined
	const faultState = { reported: false }

	try {
		throwIfStopped(c)

		let curCandidate = candidate
		let shortCircuit: { outputCandidate: unknown } | undefined

		await withSpan(c, 'cmd.before', { id }, async () => {
			for (const it of compiled.before) {
				throwIfStopped(c)
				const res = await it.fn(c, curCandidate)
				const r = asBeforeResult(res) as BeforeResult<any>
				states[it.idx] = r.state
				if (r.kind === 'shortCircuit') {
					shortCircuit = { outputCandidate: r.outputCandidate }
					return
				}
				// Allow explicit replacement to `undefined` via `'candidate' in r`.
				if ('candidate' in (r as any)) curCandidate = (r as any).candidate
			}
		})

		let inputValue: unknown
		if (shortCircuit) {
			inputValue = undefined
		} else {
			inputValue = await validateWithEvents(id, inputSchema, curCandidate, 'input', c)
		}

		if (!shortCircuit) {
			await withSpan(c, 'cmd.afterInput', { id }, async () => {
				for (const it of compiled.afterInput) {
					throwIfStopped(c)
					await it.fn(c, inputValue, states[it.idx])
				}
			})
		}

		let outputCandidate: unknown
		if (shortCircuit) {
			outputCandidate = shortCircuit.outputCandidate
		} else {
			if (!spec.handle) throw new CmdError('E_INTERNAL', 'Internal error', { message: 'Missing handler' })
			outputCandidate = await withSpan(c, 'cmd.handle', { id }, async () => await spec.handle!(inputValue, c))
		}

		await withSpan(c, 'cmd.afterOutput', { id }, async () => {
			for (const it of compiled.afterOutputRev) {
				throwIfStopped(c)
				const out = await it.fn(c, outputCandidate, states[it.idx])
				if (out && typeof out === 'object' && (out as any).kind === 'transform') {
					outputCandidate = (out as any).outputCandidate
				}
			}
		})

		const finalOutput = outputSchema ? await validateWithEvents(id, outputSchema, outputCandidate, 'output', c) : (outputCandidate as O)

		ok = true
		return finalOutput as O
	} catch (e) {
		const err = normalizeError(c, e, 'E_INTERNAL', 'Command failed')
		finalErr = err

		try {
			const recovered = await withSpan(c, 'cmd.onError', { id, code: err.code }, async () => {
				for (const it of compiled.onErrorRev) {
					throwIfStopped(c)
					const out = await it.fn(c, err, states[it.idx])
					if (!out || typeof out !== 'object' || (out as any).kind !== 'recover') continue
					if (!it.canRecover) continue

					let outputCandidate: unknown = (out as any).outputCandidate

					for (const it2 of compiled.afterOutputRev) {
						throwIfStopped(c)
						const out2 = await it2.fn(c, outputCandidate, states[it2.idx])
						if (out2 && typeof out2 === 'object' && (out2 as any).kind === 'transform') {
							outputCandidate = (out2 as any).outputCandidate
						}
					}

					const finalOutput = spec.output ? await validateWithEvents(id, spec.output, outputCandidate, 'output', c) : (outputCandidate as any)

					ok = true
					finalErr = undefined
					c.emit?.(CMD_EVENT.EXEC_RECOVERED, { id, code: err.code })
					return { recovered: true as const, value: finalOutput }
				}
				return { recovered: false as const, error: err }
			})

			if (recovered.recovered) {
				await reportFaultOnce(c, id, err, { durationMs: nowMs(c) - start, recovered: true }, faultState)
				return recovered.value as O
			}

			throw recovered.error ?? err
		} catch (e2) {
			const err2 = normalizeError(c, e2, err.code as CmdErrorCode, err.publicMessage)
			finalErr = err2
			const durationMs = nowMs(c) - start

			const fault = err2.kind === 'fault' ? err2 : err.kind === 'fault' ? err : undefined
			if (fault) await reportFaultOnce(c, id, fault, { durationMs, recovered: false }, faultState)

			c.emit?.(CMD_EVENT.EXEC_ERROR, { id, code: err2.code, durationMs })
			throw err2
		}
	} finally {
		const durationMs = nowMs(c) - start
		c.emit?.(CMD_EVENT.EXEC_END, { id, durationMs, ok: ok, ...(finalErr ? { code: finalErr.code } : {}) })
		await runInterceptorsFinally(compiled, states, { ok, durationMs, ...(finalErr ? { err: finalErr } : {}) }, c)
	}
}

export const execPlanResult = async <I, O>(
	spec: ExecSpec,
	compiled: CompiledInterceptors,
	candidate: unknown,
	ctx?: ExecCtx,
): Promise<Result<O, CmdError>> => {
	try {
		return createOk(await execPlan<I, O>(spec, compiled, candidate, ctx))
	} catch (e) {
		return createErr(normalizeError(ctx ?? EMPTY_CTX, e, 'E_INTERNAL', 'Command failed'))
	}
}
