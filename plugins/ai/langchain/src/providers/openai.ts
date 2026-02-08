import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { EmbeddingsInterface } from '@langchain/core/embeddings'
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai'

import type { LangChainChatFactory, LangChainEmbeddingsFactory, LangChainModelParams } from '../core'

function mergeParams(profileOptions: Record<string, unknown> | undefined, params: LangChainModelParams): Record<string, unknown> {
	return { ...(profileOptions ?? {}), ...(params ?? {}) }
}

function mergeConfiguration(
	profileConfig: Record<string, unknown> | undefined,
	baseURL: string | undefined,
	fetchFn: typeof fetch,
): Record<string, unknown> {
	return {
		...(profileConfig ?? {}),
		...(baseURL ? { baseURL } : {}),
		fetch: fetchFn,
	}
}

export const openAIChatFactory: LangChainChatFactory = ({ apiKey, fetch, profile, model, params }) => {
	const merged = mergeParams(profile.options, params)

	return new ChatOpenAI({
		...(merged as any),
		apiKey,
		model: model ?? profile.model,
		configuration: {
			...(mergeConfiguration(profile.config, profile.baseURL, fetch) as any),
		},
	} as any) as BaseChatModel
}

export const openAIEmbeddingsFactory: LangChainEmbeddingsFactory = ({ apiKey, fetch, profile, model, params }) => {
	const merged = mergeParams(profile.options, params)

	return new OpenAIEmbeddings({
		...(merged as any),
		apiKey,
		model: model ?? profile.model,
		configuration: {
			...(mergeConfiguration(profile.config, profile.baseURL, fetch) as any),
		},
	} as any) as EmbeddingsInterface
}
