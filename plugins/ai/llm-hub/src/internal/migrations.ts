import type { Collection } from '@pluxel/hmr/signaldb'

import type { LLMProfileDoc } from '../profiles'

type LegacyProfileDoc = LLMProfileDoc & { apiURL?: unknown }

export function migrateLegacyProfiles(profiles: Collection<LLMProfileDoc>) {
	// v0.1 legacy: `apiURL` -> `baseURL`
	const list = profiles.find().fetch() as unknown as LegacyProfileDoc[]
	for (const p of list) {
		const baseURL = typeof p.baseURL === 'string' ? p.baseURL.trim() : ''
		const apiURL = typeof p.apiURL === 'string' ? p.apiURL.trim() : ''
		if (!baseURL && apiURL) {
			profiles.updateOne({ id: p.id }, { $set: { baseURL: apiURL, updatedAt: Date.now() } as any })
		}
	}
}

