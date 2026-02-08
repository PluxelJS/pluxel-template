import { BasePlugin } from '@pluxel/hmr'
import type { EmbeddingsInterface } from '@langchain/core/embeddings'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { LLMConnection, LLMConnectionOptions, LLMResolvedProfile } from 'pluxel-plugin-llm-hub'

export type LangChainModelParams = Readonly<Record<string, unknown>>

export type LangChainResolveOptions = Readonly<{
	/** Options forwarded to `pluxel-plugin-llm-hub` connection resolution. */
	llm?: LLMConnectionOptions
	/**
	 * Model provider id used for selecting the factory.
	 * Defaults to the resolved LLM profile provider.
	 */
	provider?: string
	/** Provider-specific model id override. */
	model?: string
	/** Provider-specific constructor params (merged over profile.options). */
	params?: LangChainModelParams
}>

export type LangChainFromConnectionOptions = Readonly<Omit<LangChainResolveOptions, 'llm'>>

export type LangChainLlmMeta = Readonly<{
	/** The physical hub profile that was selected (routing/keys/health are based on this). */
	llmProfile: Pick<LLMResolvedProfile, 'id' | 'provider' | 'model' | 'baseURL' | 'title'>
	/** The effective LangChain factory + model parameters used for construction. */
	effective: Readonly<{
		providerId: string
		model?: string
	}>
}>

export type LangChainChatHandle = Readonly<{ model: BaseChatModel; meta: LangChainLlmMeta }>
export type LangChainEmbeddingsHandle = Readonly<{ embeddings: EmbeddingsInterface; meta: LangChainLlmMeta }>

export type LangChainChatFactory = (input: {
	apiKey: string
	fetch: typeof fetch
	profile: LLMResolvedProfile
	model?: string
	params: LangChainModelParams
}) => BaseChatModel | Promise<BaseChatModel>

export type LangChainEmbeddingsFactory = (input: {
	apiKey: string
	fetch: typeof fetch
	profile: LLMResolvedProfile
	model?: string
	params: LangChainModelParams
}) => EmbeddingsInterface | Promise<EmbeddingsInterface>

/**
 * Minimal LangChain integration surface.
 *
 * - Routing/health/keys are owned by `pluxel-plugin-llm-hub`.
 * - This service only constructs LangChain models from a resolved connection.
 */
export abstract class LangChain extends BasePlugin {
	abstract registerChatFactory(providerId: string, factory: LangChainChatFactory): void
	abstract registerEmbeddingsFactory(providerId: string, factory: LangChainEmbeddingsFactory): void

	/** Resolve a chat model with meta (recommended for observability/debugging). */
	abstract resolveChat(opts?: LangChainResolveOptions): Promise<LangChainChatHandle>
	/** Resolve an embeddings model with meta (recommended for observability/debugging). */
	abstract resolveEmbeddings(opts?: LangChainResolveOptions): Promise<LangChainEmbeddingsHandle>

	async chatModel(opts?: LangChainResolveOptions): Promise<BaseChatModel> {
		return (await this.resolveChat(opts)).model
	}

	async embeddings(opts?: LangChainResolveOptions): Promise<EmbeddingsInterface> {
		return (await this.resolveEmbeddings(opts)).embeddings
	}

	/**
	 * Construct LangChain models from an already-resolved hub connection.
	 *
	 * Use this to:
	 * - ensure chat + other SDKs share the exact same routed profile
	 * - avoid an extra vault read / routing pass per call
	 */
	abstract resolveChatFromConnection(conn: LLMConnection, opts?: LangChainFromConnectionOptions): Promise<LangChainChatHandle>
	abstract resolveEmbeddingsFromConnection(conn: LLMConnection, opts?: LangChainFromConnectionOptions): Promise<LangChainEmbeddingsHandle>

	async chatModelFromConnection(conn: LLMConnection, opts?: LangChainFromConnectionOptions): Promise<BaseChatModel> {
		return (await this.resolveChatFromConnection(conn, opts)).model
	}

	async embeddingsFromConnection(conn: LLMConnection, opts?: LangChainFromConnectionOptions): Promise<EmbeddingsInterface> {
		return (await this.resolveEmbeddingsFromConnection(conn, opts)).embeddings
	}
}
