import type { LLMCircuitConfig } from './profiles'
import { defaultCircuitConfig } from './profiles'

export type LLMSelectionMode = 'default-first' | 'priority-first'

export type LLMHubSettingsDoc = {
	id: 'default'
	selection: {
		mode: LLMSelectionMode
		fallback: boolean
	}
	circuit: LLMCircuitConfig
	createdAt: number
	updatedAt: number
}

export const LLM_COLLECTION_SETTINGS = 'llm:settings'

export const defaultSettings = (): LLMHubSettingsDoc => {
	const now = Date.now()
	return {
		id: 'default',
		selection: { mode: 'default-first', fallback: true },
		circuit: defaultCircuitConfig(),
		createdAt: now,
		updatedAt: now,
	}
}
