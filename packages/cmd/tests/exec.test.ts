import { describe, expect, it } from 'vitest'

import { obj, Type } from '../src'

import { CmdError, cmd } from '../src'

describe('cmdkit: exec', () => {
	it('run() validates input and output', async () => {
		const inc = cmd('inc')
			.input(obj({ x: Type.Number() }))
			.output(obj({ y: Type.Number() }))
			.handle(({ x }) => ({ y: x + 1 }))
			.build()

		await expect(inc.exec({ x: 1 })).resolves.toEqual({ ok: true, val: { y: 2 }, err: null })

		await expect(inc.exec({ x: 'nope' } as any)).resolves.toMatchObject({ ok: false, val: null, err: { code: 'E_INPUT_VALIDATION' } })
	})

	it('treats root object schemas as strict by default', async () => {
		const exec = cmd('x')
			// Note: no `additionalProperties` option.
			.input(Type.Object({ a: Type.String() }))
			.handle((i) => i.a)
			.build()

		await expect(exec.exec({ a: 'ok', extra: 1 } as any)).resolves.toMatchObject({ ok: false, err: { code: 'E_INPUT_VALIDATION' } })
		await expect(exec.exec({ a: 'ok' } as any)).resolves.toEqual({ ok: true, val: 'ok', err: null })
	})

	it('supports shortCircuit in before() and still validates output', async () => {
		let called = false

		const exec = cmd('sc')
			.output(Type.String())
			.intercept({
				before: () => ({ kind: 'shortCircuit', outputCandidate: 'ok' }),
			})
			.handle(() => {
				called = true
				return 'no'
			})
			.build()

		await expect(exec.exec({})).resolves.toEqual({ ok: true, val: 'ok', err: null })
		expect(called).toBe(false)
	})

	it('classifies cancellation and deadline timeout via ctx.signal/deadlineMs', async () => {
		const exec = cmd('stop')
			.handle(() => 'ok')
			.build()

		const ac = new AbortController()
		ac.abort('x')

		await expect(exec.exec({}, { signal: ac.signal } as any)).resolves.toMatchObject({ ok: false, val: null, err: { code: 'E_ABORTED' } })
		await expect(exec.exec({}, { deadlineMs: 100, now: 200 } as any)).resolves.toMatchObject({ ok: false, val: null, err: { code: 'E_TIMEOUT' } })
	})

	it('onError can recover only when canRecover=true', async () => {
		const exec = cmd('recover')
			.output(Type.Number())
			.intercept({
				canRecover: true,
				onError: (_ctx, err) => {
					expect(err).toBeInstanceOf(CmdError)
					return { kind: 'recover', outputCandidate: 42 }
				},
			})
			.handle(() => {
				throw new Error('boom')
			})
			.build()

		await expect(exec.exec({})).resolves.toEqual({ ok: true, val: 42, err: null })
	})

	it('unwind order: afterOutput/onError/finally run in reverse', async () => {
		const calls: string[] = []

		const exec = cmd('order')
			.output(Type.Number())
			.intercept({
				before: () => {
					calls.push('A.before')
					return { kind: 'continue', state: { a: 1 } }
				},
				afterOutput: (_ctx, _out, state) => {
					calls.push(`A.afterOutput:${(state as any)?.a ?? '?'}`)
				},
				onError: () => {
					calls.push('A.onError')
				},
				finally: () => {
					calls.push('A.finally')
				},
			})
			.intercept({
				before: () => {
					calls.push('B.before')
					return { kind: 'continue', state: { b: 2 } }
				},
				afterOutput: (_ctx, _out, state) => {
					calls.push(`B.afterOutput:${(state as any)?.b ?? '?'}`)
				},
				onError: () => {
					calls.push('B.onError')
				},
				finally: () => {
					calls.push('B.finally')
				},
			})
			.handle(() => {
				throw new Error('boom')
			})
			.build()

		await expect(exec.exec({})).resolves.toMatchObject({ ok: false, val: null, err: { code: 'E_INTERNAL' } })

		// before is forward; onError/finally are reverse.
		expect(calls.slice(0, 2)).toEqual(['A.before', 'B.before'])
		expect(calls).toContain('B.onError')
		expect(calls).toContain('A.onError')
		expect(calls).toContain('B.finally')
		expect(calls).toContain('A.finally')

		expect(calls.indexOf('B.onError')).toBeLessThan(calls.indexOf('A.onError'))
		expect(calls.indexOf('B.finally')).toBeLessThan(calls.indexOf('A.finally'))
	})

	it('validates output after afterOutput transforms (final output must match schema)', async () => {
		const exec = cmd('afterOutput.validate')
			.output(Type.Number())
			.intercept({
				afterOutput: () => ({ kind: 'transform', outputCandidate: 'nope' }),
			})
			.handle(() => 1)
			.build()

		await expect(exec.exec({})).resolves.toMatchObject({ ok: false, val: null, err: { code: 'E_OUTPUT_VALIDATION' } })
	})

	it('reports faults via ctx.onFault and emits cmd.exec.fault', async () => {
		const faults: Array<{ id: string; err: CmdError; durationMs: number; recovered: boolean }> = []
		const events: string[] = []

		const exec = cmd('boom')
			.handle(() => {
				throw new Error('boom')
			})
			.build()

		const res = await exec.exec({}, {
			emit: (type: string) => {
				events.push(type)
			},
			onFault: (p: any) => {
				faults.push(p)
			},
		} as any)

		expect(res.ok).toBe(false)
		if (!res.ok) {
			expect(res.err).toBeInstanceOf(CmdError)
			expect(res.err).toMatchObject({ code: 'E_INTERNAL', kind: 'fault' })
		}

		expect(events).toContain('cmd.exec.fault')
		expect(faults).toHaveLength(1)
		expect(faults[0]!.id).toBe('boom')
		expect(faults[0]!.err).toBeInstanceOf(CmdError)
		expect(faults[0]!.err).toMatchObject({ code: 'E_INTERNAL', kind: 'fault' })
		expect(typeof faults[0]!.durationMs).toBe('number')
		expect(faults[0]!.recovered).toBe(false)
	})

	it('allows ctx.classifyError to map infrastructure errors', async () => {
		const exec = cmd('dep')
			.handle(() => {
				throw new Error('redis down')
			})
			.build()

		const res = await exec.exec({}, {
			classifyError: (e: unknown) => new CmdError('E_DEPENDENCY', 'Dependency error', { details: { service: 'redis' }, cause: e }),
		} as any)

		expect(res.ok).toBe(false)
		if (!res.ok) {
			expect(res.err).toBeInstanceOf(CmdError)
			expect(res.err).toMatchObject({ code: 'E_DEPENDENCY', kind: 'fault' })
		}
	})

	it('aggregates validateInput() issues (no fail-fast)', async () => {
		const exec = cmd('v')
			.input(obj({ a: Type.String(), b: Type.String() }))
			.validateInput(() => [{ path: ['a'], message: 'Bad A' }])
			.validateInput(() => [{ path: ['b'], message: 'Bad B' }])
			.handle(() => 'ok')
			.build()

		await expect(exec.exec({ a: 'x', b: 'y' })).resolves.toMatchObject({
			ok: false,
			val: null,
			err: {
				code: 'E_INPUT_VALIDATION',
				details: { issues: [{ path: ['a'] }, { path: ['b'] }] },
			},
		})
	})
})
