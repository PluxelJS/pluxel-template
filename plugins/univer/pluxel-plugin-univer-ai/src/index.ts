import { BasePlugin, Plugin } from '@pluxel/hmr'
import { LLM } from 'pluxel-plugin-llm-hub'

import { UniverAIRpc } from './univer-ai.rpc'

@Plugin({ name: 'UniverAI', type: 'service' })
export class UniverAIPlugin extends BasePlugin {
	constructor(private readonly llm: LLM) {
		super()
	}

	override async init(_abort: AbortSignal): Promise<void> {
		try {
			this.ctx.ext.rpc.registerExtension(() => new UniverAIRpc(this.llm))
		} catch (error) {
			this.ctx.logger.warn('UniverAI RPC registration skipped', { error })
		}
	}
}

export default UniverAIPlugin

export { UniverAIRpc } from './univer-ai.rpc'

export type {
	UniverAiChange,
	UniverAiChangeOp,
	UniverAiChangeSet,
	UniverAiContext,
	UniverAiLlmProfile,
	UniverAiRange,
	UniverAiStructuredContext,
	UniverAiSuggestEditsInput,
	UniverAiSuggestEditsMeta,
	UniverAiSuggestEditsResult,
} from './univer-ai.types'
