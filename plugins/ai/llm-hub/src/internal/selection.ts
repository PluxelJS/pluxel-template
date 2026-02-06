import type { LLMProfileDoc } from '../profiles'
import type { LLMSelectionMode } from '../settings'

import { effectiveHealth } from './health'

export function normalizeProfileDoc(doc: LLMProfileDoc): LLMProfileDoc {
	return {
		...doc,
		priority: typeof doc.priority === 'number' ? doc.priority : 0,
		health: effectiveHealth(doc),
	}
}

export function sortCandidates(mode: LLMSelectionMode, list: LLMProfileDoc[]): LLMProfileDoc[] {
	const normalized = list.map((doc) => normalizeProfileDoc(doc))
	normalized.sort((a, b) => {
		const ap = a.priority ?? 0
		const bp = b.priority ?? 0
		const ad = a.isDefault ? 1 : 0
		const bd = b.isDefault ? 1 : 0

		if (mode === 'priority-first') {
			if (bp !== ap) return bp - ap
			if (bd !== ad) return bd - ad
		} else {
			if (bd !== ad) return bd - ad
			if (bp !== ap) return bp - ap
		}

		return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
	})
	return normalized
}

