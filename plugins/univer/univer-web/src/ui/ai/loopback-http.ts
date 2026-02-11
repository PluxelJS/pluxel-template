import type { UniverLoopbackRunInput, UniverLoopbackRunResult } from '@pluxel/univer-headless/protocol'

import type { LoopbackBackend } from './loopback-backend'

function readTextSafe(res: Response): Promise<string> {
	try {
		return res.text()
	} catch {
		return Promise.resolve('')
	}
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
			const timer =
				ac && typeof setTimeout === 'function'
					? setTimeout(() => {
							ac.abort()
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
				const json = text ? (JSON.parse(text) as UniverLoopbackRunResult) : null

				if (json && typeof json === 'object' && 'ok' in json) return json

				if (!res.ok) {
					return { ok: false, error: `loopback http ${res.status}: ${text || res.statusText}` }
				}
				return { ok: false, error: 'loopback http invalid response' }
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error)
				return { ok: false, error: `loopback http failed: ${msg}` }
			} finally {
				if (timer) clearTimeout(timer as any)
			}
		},
	}
}

