import { BasePlugin, Plugin } from '@pluxel/hmr'
import type { UniverAiCapability } from '@pluxel/univer-headless/protocol'
import { UNIVER_CAP_AI } from '@pluxel/univer-headless/protocol'
import { LLM } from 'pluxel-plugin-llm-hub'
import type { LLMError } from 'pluxel-plugin-llm-hub'
import type { Result } from 'pluxel-plugin-llm-hub'
import type { LLMConnection } from 'pluxel-plugin-llm-hub'
import UniverPlugin from 'pluxel-plugin-univer'

function capabilityFromConn(res: Result<LLMConnection, LLMError>): UniverAiCapability {
	if (!res.ok) return { available: false, reason: res.err?.message ?? 'LLM unavailable' }
	const p = res.val.profile
	return {
		available: true,
		defaultProfile: {
			id: String(p.id),
			provider: String(p.provider),
			...(typeof p.model === 'string' && p.model.trim() ? { model: p.model.trim() } : {}),
			...(typeof p.baseURL === 'string' && p.baseURL.trim() ? { baseURL: p.baseURL.trim() } : {}),
		},
	}
}

@Plugin({ name: 'UniverAI', type: 'service' })
export class UniverAIPlugin extends BasePlugin {
	constructor(
		private readonly univer: UniverPlugin,
		private readonly llm: LLM,
	) {
		super()
	}

	override async init(): Promise<void> {
		// Provide Univer AI capability via LLMHub. This does not guarantee loopback RPC exists.
		const off = this.univer.provideCapability(UNIVER_CAP_AI, async () => {
			const res = await this.llm.connectionResult()
			return capabilityFromConn(res)
		})
		this.ctx.effects.defer(off)
	}
}

export default UniverAIPlugin
