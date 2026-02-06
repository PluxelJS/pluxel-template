import { ai as axAi, type AxAI } from '@ax-llm/ax'

import type { LLMConnection } from '../core'

/**
 * Ax adapter: create an `AxAI` from a resolved hub connection.
 *
 * - Uses `conn.fetch` (instrumented: circuit breaker + health tracking).
 * - `conn.apiKey` is sensitive; never log/persist it.
 */
export function createAxAIFromConnection(conn: LLMConnection): AxAI {
	const provider = String(conn.profile.provider ?? '').trim()
	if (!provider) throw new Error('[llm] invalid profile.provider')

	const model = typeof conn.profile.model === 'string' && conn.profile.model.trim() ? conn.profile.model.trim() : undefined
	const baseURL =
		typeof conn.profile.baseURL === 'string' && conn.profile.baseURL.trim() ? conn.profile.baseURL.trim() : undefined

	const config = { ...(conn.profile.config ?? {}), ...(model ? { model } : {}) }
	const options = { ...(conn.profile.options ?? {}), fetch: conn.fetch }

	return axAi({
		name: provider as any,
		apiKey: conn.apiKey,
		...(baseURL ? { apiURL: baseURL } : {}),
		...(Object.keys(config).length ? { config: config as any } : {}),
		...(Object.keys(options).length ? { options: options as any } : {}),
	} as any) as any
}
