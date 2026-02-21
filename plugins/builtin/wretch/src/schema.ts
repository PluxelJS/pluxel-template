import type { InferOutput } from 'valibot'
import * as v from 'valibot'

import { normalizeBaseUrl } from './url'

const Credentials = ['omit', 'same-origin', 'include'] as const

const normalizeNonEmptyString = (value: string): string | undefined => {
	const trimmed = value.trim()
	return trimmed ? trimmed : undefined
}

const ClientConfig = v.object({
	baseUrl: v.optional(v.pipe(v.string(), v.transform((value) => normalizeBaseUrl(value)))),
	headers: v.optional(v.record(v.string(), v.string()), {}),
	credentials: v.optional(v.picklist(Credentials)),
	/**
	 * We intentionally keep this loose:
	 * - Wretch options are ultimately forwarded to fetch as RequestInit.
	 * - Different runtimes support different subsets.
	 */
	options: v.optional(v.record(v.string(), v.unknown())),
})

export const WretchConfig = v.object({
	defaults: v.optional(ClientConfig),
	clients: v.optional(v.record(v.string(), ClientConfig)),
	defaultClient: v.optional(v.pipe(v.string(), v.transform(normalizeNonEmptyString))),
})

export type WretchPluginConfig = InferOutput<typeof WretchConfig>
export type WretchPluginClientConfig = InferOutput<typeof ClientConfig>

export type NormalizedWretchClientConfig = {
	baseUrl?: string
	headers: Record<string, string>
	credentials?: 'omit' | 'same-origin' | 'include'
	options?: Record<string, unknown>
}

export type NormalizedWretchPluginConfig = {
	defaultClientName: string
	clients: Record<string, NormalizedWretchClientConfig>
}
