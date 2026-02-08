import { Plugin } from '@pluxel/hmr'
import type { LLMConnection } from 'pluxel-plugin-llm-hub'
import { LLM } from 'pluxel-plugin-llm-hub'

import type {
	LangChainChatFactory,
	LangChainEmbeddingsFactory,
	LangChainFromConnectionOptions,
	LangChainLlmMeta,
	LangChainResolveOptions,
} from './core'
import { LangChain } from './core'
import { lcError, lcErrorToError } from './errors'
import { openAIChatFactory, openAIEmbeddingsFactory } from './providers/openai'

function normalizeProviderId(raw: string | undefined): string {
	return String(raw ?? '').trim().toLowerCase()
}

function normalizeOptionalString(raw: unknown): string | undefined {
	const trimmed = String(raw ?? '').trim()
	return trimmed ? trimmed : undefined
}

function normalizeParams(raw: unknown): Readonly<Record<string, unknown>> {
	if (!raw) return {}
	if (typeof raw !== 'object' || Array.isArray(raw)) throw lcErrorToError(lcError('E_INVALID_INPUT', 'params must be an object'))
	return raw as Record<string, unknown>
}

function metaFromProfile(
	profile: { id: string; provider: string; model?: string; baseURL?: string; title?: string },
	effective: { providerId: string; model?: string },
): LangChainLlmMeta {
	return {
		llmProfile: { id: profile.id, provider: profile.provider, model: profile.model, baseURL: profile.baseURL, title: profile.title },
		effective,
	}
}

@Plugin(LangChain, { name: 'LangChain', type: 'service' })
export class LangChainService extends LangChain {
	private readonly chatFactories = new Map<string, LangChainChatFactory>()
	private readonly embeddingsFactories = new Map<string, LangChainEmbeddingsFactory>()

	constructor(private readonly llm: LLM) {
		super()
	}

	override registerChatFactory(providerId: string, factory: LangChainChatFactory): void {
		const key = normalizeProviderId(providerId)
		if (!key) throw lcErrorToError(lcError('E_INVALID_INPUT', 'providerId must be non-empty'))
		this.chatFactories.set(key, factory)
	}

	override registerEmbeddingsFactory(providerId: string, factory: LangChainEmbeddingsFactory): void {
		const key = normalizeProviderId(providerId)
		if (!key) throw lcErrorToError(lcError('E_INVALID_INPUT', 'providerId must be non-empty'))
		this.embeddingsFactories.set(key, factory)
	}

	override async init(): Promise<void> {
		// Built-in: OpenAI-compatible (via @langchain/openai).
		this.registerChatFactory('openai', openAIChatFactory)
		this.registerEmbeddingsFactory('openai', openAIEmbeddingsFactory)
	}

	private resolveChatFactory(providerId: string): LangChainChatFactory {
		const key = normalizeProviderId(providerId)
		const f = this.chatFactories.get(key)
		if (!f) throw lcErrorToError(lcError('E_UNSUPPORTED_PROVIDER', `unsupported provider: ${providerId}`, { providerId }))
		return f
	}

	private resolveEmbeddingsFactory(providerId: string): LangChainEmbeddingsFactory {
		const key = normalizeProviderId(providerId)
		const f = this.embeddingsFactories.get(key)
		if (!f) throw lcErrorToError(lcError('E_UNSUPPORTED_PROVIDER', `unsupported provider: ${providerId}`, { providerId }))
		return f
	}

	private resolveProviderId(explicit: string | undefined, fallback: string, label: string): string {
		if (explicit === undefined) return normalizeProviderId(fallback)
		const key = normalizeProviderId(explicit)
		if (!key) throw lcErrorToError(lcError('E_INVALID_INPUT', `${label} must be non-empty`))
		return key
	}

	override async resolveChat(opts?: LangChainResolveOptions) {
		const conn = await this.llm.connection(opts?.llm)
		return await this.resolveChatFromConnection(conn, { provider: opts?.provider, model: opts?.model, params: opts?.params })
	}

	override async resolveEmbeddings(opts?: LangChainResolveOptions) {
		const conn = await this.llm.connection(opts?.llm)
		return await this.resolveEmbeddingsFromConnection(conn, { provider: opts?.provider, model: opts?.model, params: opts?.params })
	}

	override async resolveChatFromConnection(conn: LLMConnection, opts?: LangChainFromConnectionOptions) {
		const providerId = this.resolveProviderId(opts?.provider, conn.profile.provider, 'provider')
		const model = normalizeOptionalString(opts?.model) ?? normalizeOptionalString(conn.profile.model)
		const factory = this.resolveChatFactory(providerId)
		const out = await factory({
			apiKey: conn.apiKey,
			fetch: conn.fetch,
			profile: conn.profile,
			model,
			params: normalizeParams(opts?.params),
		})
		return { model: out, meta: metaFromProfile(conn.profile, { providerId, model }) }
	}

	override async resolveEmbeddingsFromConnection(conn: LLMConnection, opts?: LangChainFromConnectionOptions) {
		const providerId = this.resolveProviderId(opts?.provider, conn.profile.provider, 'provider')
		const model = normalizeOptionalString(opts?.model) ?? normalizeOptionalString(conn.profile.model)
		const factory = this.resolveEmbeddingsFactory(providerId)
		const out = await factory({
			apiKey: conn.apiKey,
			fetch: conn.fetch,
			profile: conn.profile,
			model,
			params: normalizeParams(opts?.params),
		})
		return { embeddings: out, meta: metaFromProfile(conn.profile, { providerId, model }) }
	}
}

export default LangChainService
