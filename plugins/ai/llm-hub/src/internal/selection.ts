import type { LLMProfileDoc } from '../profiles'

import { effectiveHealth } from './health'

export function normalizeProfileDoc(doc: LLMProfileDoc): LLMProfileDoc {
	return {
		...doc,
		priority: typeof doc.priority === 'number' ? doc.priority : 0,
		health: effectiveHealth(doc),
	}
}

export function sortCandidates(list: LLMProfileDoc[]): LLMProfileDoc[] {
	const normalized = list.map((doc) => normalizeProfileDoc(doc))
	normalized.sort((a, b) => {
		const ap = a.priority ?? 0
		const bp = b.priority ?? 0
		if (bp !== ap) return bp - ap

		return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
	})
	return normalized
}
