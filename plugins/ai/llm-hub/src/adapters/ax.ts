import { ai as axAi, type AxAI, type AxAIServiceOptions, type AxModelConfig } from '@ax-llm/ax'

import type { LLMConnection } from '../core'

export type AxAdapterPurpose = 'default' | 'loopback'

export type CreateAxAIOverrides = Readonly<{
	/**
	 * Adapter purpose:
	 * - `default`: respect profile options
	 * - `loopback`: enforce deterministic + compat-friendly defaults (e.g. no streaming)
	 */
	purpose?: AxAdapterPurpose
	/** Override the Ax provider name (e.g. `openai-responses`). */
	providerName?: string
	/** Override model (or set one when profile.model is empty). */
	model?: string
	/** Additional Ax model config overrides. */
	config?: Readonly<Partial<AxModelConfig> & Record<string, unknown>>
	/** Additional Ax service options overrides. */
	options?: Readonly<Partial<AxAIServiceOptions> & Record<string, unknown>>
}>

type AxProfileMeta = Readonly<{
	providerName?: string
	purpose?: AxAdapterPurpose
	config?: Readonly<Record<string, unknown>>
	options?: Readonly<Record<string, unknown>>
}>

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== 'object') return null
	return value as Record<string, unknown>
}

function pickString(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined
	const t = value.trim()
	return t ? t : undefined
}

function omitKeys(obj: Readonly<Record<string, unknown>>, keys: readonly string[]): Record<string, unknown> {
	if (!keys.length) return { ...obj }
	const out: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(obj)) {
		if (keys.includes(k)) continue
		out[k] = v
	}
	return out
}

function resolveAxMeta(profileOptions: unknown): Readonly<{ meta: AxProfileMeta; baseOptions: Record<string, unknown> }> {
	const optionsObj = asRecord(profileOptions) ?? {}

	const axProviderName =
		pickString(optionsObj.axProvider) ??
		pickString(optionsObj.axProviderName) ??
		(() => {
			const ax = asRecord(optionsObj.ax)
			return ax ? pickString(ax.providerName ?? ax.provider ?? ax.name) : undefined
		})()

	const ax = asRecord(optionsObj.ax)
	const meta: AxProfileMeta = {
		...(axProviderName ? { providerName: axProviderName } : {}),
		...(() => {
			const purpose = ax ? pickString(ax.purpose) : undefined
			if (purpose === 'loopback' || purpose === 'default') return { purpose }
			return {}
		})(),
		...(ax && asRecord(ax.config) ? { config: asRecord(ax.config) ?? undefined } : {}),
		...(ax && asRecord(ax.options) ? { options: asRecord(ax.options) ?? undefined } : {}),
	}

	const baseOptions = omitKeys(optionsObj, ['ax', 'axProvider', 'axProviderName'])
	return { meta, baseOptions }
}

/**
 * Ax adapter: create an `AxAI` from a resolved hub connection.
 *
 * - Uses `conn.fetch` (instrumented: circuit breaker + health tracking).
 * - `conn.apiKey` is sensitive; never log/persist it.
 */
export function createAxAIFromConnection(conn: LLMConnection, overrides?: CreateAxAIOverrides): AxAI {
	const fallbackProviderName = pickString(conn.profile.provider)
	if (!fallbackProviderName) throw new Error('[llm] invalid profile.provider')

	const { meta, baseOptions } = resolveAxMeta(conn.profile.options)
	const providerName = overrides?.providerName ?? meta.providerName ?? fallbackProviderName

	let model = pickString(overrides?.model) ?? pickString(conn.profile.model)
	// DeepSeek commonly expects a model name even if baseURL is correct.
	if (!model && providerName === 'deepseek') model = 'deepseek-chat'
	const baseURL =
		typeof conn.profile.baseURL === 'string' && conn.profile.baseURL.trim() ? conn.profile.baseURL.trim() : undefined

	const purpose: AxAdapterPurpose = overrides?.purpose ?? meta.purpose ?? 'default'

	const config = { ...(conn.profile.config ?? {}), ...(meta.config ?? {}), ...(overrides?.config ?? {}), ...(model ? { model } : {}) }

	const baseFetch = conn.fetch
	const wrappedFetch: typeof fetch = (() => {
		if (purpose !== 'loopback') return baseFetch
		const fn = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const res = await baseFetch(input, init)
			// IMPORTANT: do not throw on upstream HTTP 4xx here.
			// If we throw, Ax will classify it as a network error and may retry until its global timeout,
			// which makes loopback "hang" and the UI will hit its 5-minute HTTP timeout.
			//
			// Instead, for non-auth/ratelimit 4xx, buffer the body and return a *new* Response with a replayable body.
			// This keeps Ax's error classification as a status error (non-retryable) and preserves the upstream payload.
			if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403 && res.status !== 429) {
				try {
					const bodyText = await res.text()
					return new Response(bodyText, {
						status: res.status,
						statusText: res.statusText,
						headers: new Headers(res.headers),
					})
				} catch {
					// If buffering fails, fall back to the original response.
					return res
				}
			}
			return res
		}
		// Bun's `fetch` typing includes a required `.preconnect()` method. Preserve it when present.
		return Object.assign(fn, {
			preconnect: (...args: any[]) => (baseFetch as any).preconnect?.(...args),
		}) as any
	})()

	const options = { ...baseOptions, ...(meta.options ?? {}), ...(overrides?.options ?? {}), fetch: wrappedFetch }
	if (purpose === 'loopback') {
		// Loopback is accuracy-first, backend-only; disable streaming for determinism + provider compatibility.
		// NOTE: Ax's OpenAI-compatible clients currently control request streaming via *config.stream* (not only options.stream).
		;(config as any).stream = false
		;(options as any).stream = false
		;(options as any).streamingUsage = false
	}

	return axAi({
		name: providerName as any,
		apiKey: conn.apiKey,
		...(baseURL ? { apiURL: baseURL } : {}),
		...(Object.keys(config).length ? { config: config as any } : {}),
		...(Object.keys(options).length ? { options: options as any } : {}),
	} as any) as any
}
