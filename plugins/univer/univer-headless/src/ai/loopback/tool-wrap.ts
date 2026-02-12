import { AxFunctionError, type AxFunction } from '@ax-llm/ax'
import type { McpStats } from '../mcp/context'
import { inferAxFunctionErrorField, hintForToolError } from './function-error'
import { classifyToolKind } from './tool-kind'
import { sanitizeToolPayload } from './text'
import type { UniverAxOtel, UniverAxOtelInstruments } from './otel'
import { spanError, spanOk } from './otel'

export type WrapAxToolOptions = Readonly<{
	stats?: McpStats
	nextSeq?: () => number
	otel?: UniverAxOtel
	otelInstruments?: UniverAxOtelInstruments
}>

export function wrapAxTool(tool: AxFunction, opts?: WrapAxToolOptions): AxFunction {
	const fn = tool.func
	if (typeof fn !== 'function') return tool
	const name = String(tool.name ?? '')
	return {
		...tool,
		func: async (input: any, extra?: any) => {
			const seq = opts?.nextSeq?.()
			if (typeof seq === 'number' && opts?.stats) {
				opts.stats.callSeq = seq
				const kind = classifyToolKind(name)
				if (kind === 'read') {
					opts.stats.lastReadSeq = seq
					opts.stats.lastReadTool = name
				} else if (kind === 'write') {
					opts.stats.lastWriteSeq = seq
					opts.stats.lastWriteTool = name
				}
			}

			const t0 = Date.now()
			const kind = classifyToolKind(name)
			const tracer = opts?.otel?.tracer
			const instruments = opts?.otelInstruments
			instruments?.toolCalls?.add(1, { 'univer.tool.name': name, 'univer.tool.kind': kind })

			const baseAttrs = {
				...(opts?.otel?.attributes ?? {}),
				'univer.tool.name': name,
				'univer.tool.kind': kind,
				...(typeof seq === 'number' ? { 'univer.tool.seq': seq } : {}),
				'univer.tool.input.summary': truncateOtelValue(JSON.stringify(sanitizeToolPayload(input)), 1200),
			} as const

			const run = async (span: any | null) => {
				try {
					const res = await fn(input, extra)
					if (typeof seq === 'number' && opts?.stats) {
						const hasReadback =
							!!res &&
							typeof res === 'object' &&
							'readback' in (res as Record<string, unknown>) &&
							(res as Record<string, unknown>).readback != null
						if (kind === 'write' && hasReadback) {
							opts.stats.lastVerifySeq = seq
							opts.stats.lastVerifyTool = `${name}#readback`
						}
					}
					const dt = Date.now() - t0
					instruments?.toolLatencyMs?.record(dt, { 'univer.tool.name': name, 'univer.tool.kind': kind })
					if (span) {
						span.setAttribute('univer.tool.duration_ms', dt)
						span.setAttribute('univer.tool.output.summary', truncateOtelValue(JSON.stringify(sanitizeToolPayload(res)), 1200))
					}
					return res
				} catch (error) {
					const dt = Date.now() - t0
					instruments?.toolLatencyMs?.record(dt, { 'univer.tool.name': name, 'univer.tool.kind': kind, 'univer.tool.ok': false })
					instruments?.toolErrors?.add(1, { 'univer.tool.name': name, 'univer.tool.kind': kind })
					if (typeof seq === 'number' && opts?.stats) {
						opts.stats.toolErrors = (opts.stats.toolErrors ?? 0) + 1
						opts.stats.lastErrorSeq = seq
						opts.stats.lastErrorTool = name
					}
					if (span) span.setAttribute('univer.tool.duration_ms', dt)
					throw error
				}
			}

			if (!tracer) {
				try {
					return await run(null)
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error)
					const hint = hintForToolError(name, message)
					const field = inferAxFunctionErrorField(name, message)
					const full = hint ? `${message}\nHint: ${hint}` : message
					throw new AxFunctionError([{ field, message: full }])
				}
			}

			return await tracer.startActiveSpan('univer.tool', { attributes: baseAttrs }, async (span) => {
				try {
					const res = await run(span)
					spanOk(span)
					return res
				} catch (error) {
					spanError(span, error)
					const message = error instanceof Error ? error.message : String(error)
					const hint = hintForToolError(name, message)
					const field = inferAxFunctionErrorField(name, message)
					const full = hint ? `${message}\nHint: ${hint}` : message
					throw new AxFunctionError([{ field, message: full }])
				} finally {
					span.end()
				}
			})
		},
	}
}

function truncateOtelValue(input: string, maxChars: number) {
	if (input.length <= maxChars) return input
	return `${input.slice(0, Math.max(0, maxChars - 1))}…`
}
