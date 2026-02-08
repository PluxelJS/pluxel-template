import type { LLMCircuitConfig } from './profiles'
import { defaultCircuitConfig } from './profiles'

export type LLMHubSettingsDoc = {
	id: 'default'
	circuit: LLMCircuitConfig
	createdAt: number
	updatedAt: number
}

export const LLM_COLLECTION_SETTINGS = 'llm:settings'

export const defaultSettings = (): LLMHubSettingsDoc => {
	const now = Date.now()
	return {
		id: 'default',
		circuit: defaultCircuitConfig(),
		createdAt: now,
		updatedAt: now,
	}
}
