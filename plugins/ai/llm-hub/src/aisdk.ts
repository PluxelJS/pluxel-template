import type { LLMConnection } from './core'

/**
 * Minimal options shape used by Vercel AI SDK provider constructors.
 *
 * Example:
 * ```ts
 * const openai = createOpenAI(toAISDKProviderOptions(conn))
 * ```
 */
export type AISDKProviderOptions = Readonly<{
	apiKey: string
	baseURL?: string
	fetch: typeof fetch
}>

export function toAISDKProviderOptions(conn: LLMConnection): AISDKProviderOptions {
	const baseURL = typeof conn.profile.baseURL === 'string' && conn.profile.baseURL.trim() ? conn.profile.baseURL.trim() : undefined
	return {
		apiKey: conn.apiKey,
		...(baseURL ? { baseURL } : {}),
		fetch: conn.fetch,
	}
}
