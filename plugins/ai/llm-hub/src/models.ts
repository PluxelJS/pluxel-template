export function resolveModelListUrl(baseURL: string, modelListPath?: string | null): string | null {
	if (modelListPath === null) return null
	const trimmed = baseURL.trim().replace(/\/+$/g, '')
	if (!trimmed) return null
	const path = typeof modelListPath === 'string' && modelListPath.trim() ? modelListPath.trim() : '/models'
	if (path.startsWith('http')) return path
	return `${trimmed}${path.startsWith('/') ? '' : '/'}${path}`
}

export function parseModelList(payload: unknown): string[] {
	if (!payload) return []
	if (Array.isArray(payload)) return payload.filter((item): item is string => typeof item === 'string')
	if (typeof payload !== 'object') return []

	const obj = payload as Record<string, unknown>
	const data = obj.data
	if (Array.isArray(data)) {
		const out = data
			.map((item) => {
				if (!item || typeof item !== 'object') return null
				const id = (item as Record<string, unknown>).id
				return typeof id === 'string' ? id : null
			})
			.filter((v): v is string => !!v)
		if (out.length) return out
	}

	const models = obj.models
	if (Array.isArray(models)) {
		return models.filter((item): item is string => typeof item === 'string')
	}

	return []
}
