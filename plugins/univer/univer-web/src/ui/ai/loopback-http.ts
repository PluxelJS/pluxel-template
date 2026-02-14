import type { UniverLoopbackRunInput, UniverLoopbackRunResult } from '@pluxel/univer-headless/protocol'

import type { LoopbackBackend } from './loopback-backend'

async function readTextSafe(res: Response): Promise<string> {
	try {
		return await res.text()
	} catch {
		return ''
	}
}

function safeJsonParse(text: string): unknown {
	try {
		return JSON.parse(text) as unknown
	} catch {
		return null
	}
}

function formatPreview(text: string, maxChars: number): string {
	const s = String(text ?? '')
	if (s.length <= maxChars) return s
	return `${s.slice(0, Math.max(0, maxChars - 1))}…`
}

export function createHttpLoopbackBackend(opts?: {
	endpoint?: string
	timeoutMs?: number
}): LoopbackBackend {
	const endpoint = opts?.endpoint ?? '/api/univer/loopback/run'
	const timeoutMs = typeof opts?.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) ? Math.floor(opts.timeoutMs) : 5 * 60_000

	return {
		runLoopback: async (input: UniverLoopbackRunInput): Promise<UniverLoopbackRunResult> => {
			const ac = typeof AbortController !== 'undefined' ? new AbortController() : null
			let timedOut = false
			const timer: ReturnType<typeof setTimeout> | null =
				ac && typeof setTimeout === 'function'
					? setTimeout(() => {
							timedOut = true
							try {
								// Prefer a reason when supported; some runtimes surface it in error messages.
								ac.abort(new Error(`timeout after ${timeoutMs}ms`))
							} catch {
								ac.abort()
							}
						}, timeoutMs)
					: null

			try {
				const res = await fetch(endpoint, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(input),
					signal: ac?.signal,
				})

				const text = await readTextSafe(res)
				const contentType = res.headers.get('content-type') ?? ''
				const trimmed = text.trim()
				const maybeJson =
					contentType.includes('application/json') ||
					trimmed.startsWith('{') ||
					trimmed.startsWith('[') ||
					trimmed === 'null' ||
					trimmed === 'true' ||
					trimmed === 'false' ||
					/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)
				const parsed = text && maybeJson ? safeJsonParse(text) : null
				const json = parsed as UniverLoopbackRunResult | null

				if (json && typeof json === 'object' && 'ok' in json) return json

				if (!res.ok) {
					const hint =
						res.status === 404
							? ' (UniverLoopback 未启用？请检查 HMR profile 是否启用 UniverLoopback / pluxel-plugin-univer-loopback)'
							: ''
					return { ok: false, error: `loopback http ${res.status}: ${formatPreview(text || res.statusText, 400)}${hint}` }
				}
				return { ok: false, error: `loopback http invalid response: ${formatPreview(text || '(empty)', 400)}` }
			} catch (error) {
				if (timedOut) return { ok: false, error: `loopback http timeout after ${timeoutMs}ms` }
				const msg = error instanceof Error ? error.message : String(error)
				return { ok: false, error: `loopback http failed: ${msg}` }
			} finally {
				if (timer) clearTimeout(timer)
			}
		},
	}
}
