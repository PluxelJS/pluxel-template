export { LangChain } from './core'
export type {
	LangChainChatFactory,
	LangChainChatHandle,
	LangChainEmbeddingsFactory,
	LangChainEmbeddingsHandle,
	LangChainFromConnectionOptions,
	LangChainLlmMeta,
	LangChainModelParams,
	LangChainResolveOptions,
} from './core'
export type { LangChainError, LangChainErrorCode } from './errors'

import LangChainService from './service'
export { LangChainService } from './service'

/** Default provider plugin (LLM Hub adapter + factories). */
export { LangChainService as default } from './service'

/** Convenience export for plugin registration. */
export const plugins = [LangChainService] as const
