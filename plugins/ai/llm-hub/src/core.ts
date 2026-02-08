import { BasePlugin } from '@pluxel/hmr'

import type { LLMError } from './errors'
import { llmErrorToError } from './errors'
import type { Result } from './result'
import type { LLMProfileId, LLMProfileDoc } from './profiles'

export type LLMConnectionOptions = {
	profileId?: LLMProfileId
	/**
	 * When `profileId` is not provided, allow falling back to other usable profiles.
	 * Defaults to `true`.
	 */
	allowFallback?: boolean
	/** Respect circuit breaker by default; set to `true` to allow selecting open circuits. */
	allowCircuitOpen?: boolean
	/** Optional request correlation ids, propagated into upstream requests as headers. */
	traceId?: string
	sessionId?: string
}

export type LLMResolvedProfile = Readonly<
	Omit<Pick<LLMProfileDoc, 'id' | 'title' | 'provider' | 'model' | 'baseURL' | 'config' | 'options'>, 'config' | 'options'> & {
		config: Readonly<Record<string, unknown>>
		options: Readonly<Record<string, unknown>>
	}
>

/**
 * A generic "connection" that callers can use with *any* upstream SDK.
 *
 * Notes:
 * - `apiKey` is sensitive: never persist or log it.
 * - `fetch` is instrumented with the hub's circuit breaker + health tracking.
 */
export type LLMConnection = Readonly<{
	profile: LLMResolvedProfile
	apiKey: string
	fetch: typeof fetch
}>

/**
 * Minimal LLM service surface for other plugins: provider resolution only.
 *
 * Design goals:
 * - Stable DI token: other plugins depend on `LLM` (this class) and do not care about the provider.
 * - Small API: build on top of `connection()` only; keep any SDK/tooling declared at callsites.
 * - Explicit behavior: this plugin never "silently" converts your payload formats; keep any payload conversions explicit in your callsite (see `@pluxel/promptkit/toon`).
 */
export abstract class LLM extends BasePlugin {
	/**
	 * Generic provider resolution (SDK-agnostic).
	 */
	abstract connectionResult(opts?: LLMConnectionOptions): Promise<Result<LLMConnection, LLMError>>

	async connection(opts?: LLMConnectionOptions): Promise<LLMConnection> {
		const res = await this.connectionResult(opts)
		if (!res.ok) throw llmErrorToError(res.err)
		return res.val
	}
}
