export { LLM } from './core'
export type { LLMConnectionOptions, LLMConnection, LLMResolvedProfile } from './core'
export type { LLMError, LLMErrorCode } from './errors'
export type { Result } from './result'
export type { LLMProfileId, LLMProfilePublic } from './profiles'
export type { LLMHubSettingsDoc } from './settings'

/** Default provider plugin (profiles + vault + UI). */
export { LLMHub as default } from './hub'

import { LLMHub } from './hub'
export { LLMHub } from './hub'

/** Convenience export for plugin registration. */
export const plugins = [LLMHub] as const
