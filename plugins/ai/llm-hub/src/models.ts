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

export async function fetchModelList(input: {
	baseURL: string
	apiKey?: string
	modelListPath?: string | null
	fetch?: typeof globalThis.fetch
}): Promise<string[]> {
	const url = resolveModelListUrl(input.baseURL, input.modelListPath)
	if (!url) throw new Error('models endpoint unavailable')
	if (!/^https?:\/\//i.test(url)) throw new Error('models url invalid')

	const baseFetch = input.fetch ?? globalThis.fetch
	if (typeof baseFetch !== 'function') throw new Error('global fetch() is not available')

	const headers: Record<string, string> = { Accept: 'application/json' }
	const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`
		headers['X-API-Key'] = apiKey
	}

	const res = await baseFetch(url, { headers })
	if (!res?.ok) {
		const status = typeof (res as any)?.status === 'number' ? (res as any).status : 0
		let text = ''
		try {
			text = typeof (res as any)?.text === 'function' ? await (res as any).text() : ''
		} catch {
			// ignore
		}
		const msg = typeof text === 'string' && text ? ` ${text.slice(0, 200)}` : ''
		throw new Error(`upstream ${status}${msg}`.trim())
	}

	let payload: unknown = null
	try {
		payload = typeof (res as any)?.json === 'function' ? await (res as any).json() : null
	} catch {
		payload = null
	}
	const models = parseModelList(payload)
	if (!models.length) throw new Error('models list empty or unrecognized')

	return [...new Set(models)].sort((a, b) => a.localeCompare(b))
}
