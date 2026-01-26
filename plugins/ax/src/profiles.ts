import crypto from 'node:crypto'

export type AxProfileId = string

export type AxProfileDoc = {
	id: AxProfileId
	enabled: boolean
	isDefault: boolean
	title?: string
	provider: string
	model?: string
	apiURL?: string
	config: Record<string, unknown>
	options: Record<string, unknown>
	apiKeyPreview?: string
	createdAt: number
	updatedAt: number
}

export type AxProfilePublic = AxProfileDoc & {
	configKeys: string[]
	optionsKeys: string[]
	hasApiKey: boolean
}

export const AX_COLLECTION_PROFILES = 'ax:profiles'

export const axVaultKeyForProfile = (id: AxProfileId) => `${AX_COLLECTION_PROFILES}:${id}:apiKey`

export const createProfileId = (): AxProfileId => crypto.randomUUID()

export const maskToken = (token: string) => {
	const t = String(token ?? '').trim()
	if (t.length <= 8) return `${t.slice(0, 2)}***${t.slice(-2)}`
	return `${t.slice(0, 4)}…${t.slice(-4)}`
}

export const toPublicProfile = (doc: AxProfileDoc, hasApiKey: boolean): AxProfilePublic => ({
	...doc,
	configKeys: Object.keys(doc.config ?? {}).sort((a, b) => a.localeCompare(b)),
	optionsKeys: Object.keys(doc.options ?? {}).sort((a, b) => a.localeCompare(b)),
	hasApiKey,
})
