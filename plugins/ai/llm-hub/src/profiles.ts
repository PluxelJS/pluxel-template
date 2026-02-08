import crypto from 'node:crypto'

export type LLMProfileId = string

export type LLMCircuitConfig = {
	enabled: boolean
	/** Open the circuit after this many consecutive failures. */
	failureThreshold: number
	/** How long to keep the circuit open (ms). */
	openMs: number
}

export type LLMProfileHealth = {
	consecutiveFailures: number
	lastFailureAt?: number
	lastFailureCode?: string
	lastFailureMessage?: string
	lastSuccessAt?: number
	/** If set and > now, the circuit is considered open. */
	openUntil?: number
}

export type LLMProfileDoc = {
	id: LLMProfileId
	enabled: boolean
	/** Higher wins when selecting candidates. */
	priority?: number
	title?: string
	provider: string
	model?: string
	baseURL?: string
	config: Record<string, unknown>
	options: Record<string, unknown>
	circuit?: Partial<LLMCircuitConfig>
	health?: Partial<LLMProfileHealth>
	apiKeyPreview?: string
	createdAt: number
	updatedAt: number
}

export type LLMProfilePublic = LLMProfileDoc & {
	configKeys: string[]
	optionsKeys: string[]
	hasApiKey: boolean
}

export const LLM_COLLECTION_PROFILES = 'llm:profiles'

export const llmVaultKeyForProfile = (id: LLMProfileId) => `${LLM_COLLECTION_PROFILES}:${id}:apiKey`

export const createProfileId = (): LLMProfileId => crypto.randomUUID()

export const maskToken = (token: string) => {
	const t = String(token ?? '').trim()
	if (t.length <= 8) return `${t.slice(0, 2)}***${t.slice(-2)}`
	return `${t.slice(0, 4)}…${t.slice(-4)}`
}

export const defaultCircuitConfig = (): LLMCircuitConfig => ({
	enabled: true,
	failureThreshold: 3,
	openMs: 30_000,
})

export const defaultHealth = (): LLMProfileHealth => ({
	consecutiveFailures: 0,
})

export const toPublicProfile = (doc: LLMProfileDoc, hasApiKey: boolean): LLMProfilePublic => ({
	...doc,
	configKeys: Object.keys(doc.config ?? {}).sort((a, b) => a.localeCompare(b)),
	optionsKeys: Object.keys(doc.options ?? {}).sort((a, b) => a.localeCompare(b)),
	hasApiKey,
})
