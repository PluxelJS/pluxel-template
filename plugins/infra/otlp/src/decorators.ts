import { pluginMethodDecorator } from '@pluxel/hmr'
import type { OtlpAttributes, OtlpLogLevel, OtlpLogger } from './core.js'
import { Otlp } from './core.js'

type AnyFn = (...args: any[]) => any
type CtxBuilder<Args extends any[]> = (args: Args, method: string) => OtlpAttributes | undefined

export function WithOtlp(): MethodDecorator {
	return pluginMethodDecorator(Otlp, async function (original: AnyFn, otlp: Otlp, _key, ...args: any[]) {
		return await original.call(this, otlp, ...args)
	})
}

export function WithOtlpLogger<Args extends any[] = any[]>(opts?: { attributes?: OtlpAttributes | CtxBuilder<Args> }): MethodDecorator {
	return pluginMethodDecorator(Otlp, async function (original: AnyFn, otlp: Otlp, key, ...args: any[]) {
		const method = String(key)
		const attrs = typeof opts?.attributes === 'function' ? (opts.attributes as any)(args, method) : opts?.attributes
		const log: OtlpLogger = otlp.logger({ attributes: attrs })
		return await original.call(this, log, ...args)
	})
}

type AttrBuilder<Args extends any[]> = (args: Args, method: string) => OtlpAttributes | undefined

/**
 * Method decorator: emit a span to OTLP on success/failure.
 *
 * Notes:
 * - Best-effort by default (does not block the wrapped method).
 * - For strict backpressure, configure `queueCfg.overflow = "block"` and avoid `void` usage yourself.
 */
export function OtlpSpan<Args extends any[] = any[]>(opts?: {
	name?: string
	level?: OtlpLogLevel
	attributes?: OtlpAttributes | AttrBuilder<Args>
	errorLevel?: OtlpLogLevel
}): MethodDecorator {
	return pluginMethodDecorator(Otlp, async function (original: AnyFn, otlp: Otlp, key, ...args: any[]) {
		const method = String(key)
		const name = opts?.name ?? method
		const base = typeof opts?.attributes === 'function' ? (opts.attributes as any)(args, method) : opts?.attributes
		const t0 = Date.now()
		try {
			const out = await original.apply(this, args)
			const t1 = Date.now()
			const durationMs = Math.max(0, t1 - t0)
			const tracesEnabled = otlp.stats().signals.traces.enabled
			if (tracesEnabled) {
				const span = otlp.span(name, { attributes: { ...base, ok: true, method, durationMs } })
				void span.end({ status: 'ok', endTsMs: t1 })
			} else {
				void otlp.log({
					level: opts?.level ?? 'info',
					body: name,
					attributes: { ...base, 'otel.kind': 'span', ok: true, method, durationMs },
					tsMs: t1,
				})
			}
			return out
		} catch (err) {
			const t1 = Date.now()
			const durationMs = Math.max(0, t1 - t0)
			const tracesEnabled = otlp.stats().signals.traces.enabled
			if (tracesEnabled) {
				const span = otlp.span(name, {
					attributes: {
						...base,
						ok: false,
						method,
						durationMs,
						error: err instanceof Error ? err.message : String(err),
					},
				})
				void span.end({ status: 'error', error: err, endTsMs: t1 })
			} else {
				void otlp.log({
					level: opts?.errorLevel ?? 'error',
					body: name,
					attributes: {
						...base,
						'otel.kind': 'span',
						ok: false,
						method,
						durationMs,
						error: err instanceof Error ? err.message : String(err),
					},
					tsMs: t1,
				})
			}
			throw err
		}
	})
}
