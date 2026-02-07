import { RpcTarget } from '@pluxel/hmr/capnweb'
import { ax } from '@ax-llm/ax'
import { formatStructured } from '@pluxel/promptkit/toon'
import { LLM } from 'pluxel-plugin-llm-hub'
import { createAxAIFromConnection } from 'pluxel-plugin-llm-hub/adapters/ax'
import { randomUUID } from 'node:crypto'

import { buildSuggestEditsPrompt } from './univer-ai.prompt'
import { parseChangeSetJsonText } from './univer-ai.parse'
import type { UniverAiSuggestEditsInput, UniverAiSuggestEditsResult } from './univer-ai.types'

function parseContextJson(input: UniverAiSuggestEditsInput): unknown {
	if (input.context.format !== 'json') return null
	try {
		return JSON.parse(input.context.text)
	} catch (e) {
		const msg = typeof (e as any)?.message === 'string' ? (e as any).message : 'invalid json'
		throw new Error(`[univer-ai] context.json parse failed: ${msg}`)
	}
}

export class UniverAIRpc extends RpcTarget {
	constructor(private readonly llm: LLM) {
		super()
	}

	async suggestEdits(input: UniverAiSuggestEditsInput): Promise<UniverAiSuggestEditsResult> {
		const createdAt = Date.now()
		const id = randomUUID()

		const ctxToon =
			input.context.format === 'toon'
				? {
						format: 'toon' as const,
						contentType: input.context.contentType,
						text: String(input.context.text ?? ''),
					}
				: formatStructured(parseContextJson(input) ?? { workbookId: input.workbookId }, { format: 'toon' })

		const prompt = buildSuggestEditsPrompt(
			{
				...input,
				context: ctxToon,
			},
			ctxToon.text,
		)

		const conn = await this.llm.connection({ traceId: id, sessionId: input.workbookId })
		const ai = createAxAIFromConnection(conn)
		const gen = ax('prompt:string -> out:string')
		const out = await gen.forward(ai, { prompt })

		const text = typeof (out as any)?.out === 'string' ? (out as any).out : JSON.stringify(out)
		const changeSet = parseChangeSetJsonText({ workbookId: input.workbookId, createdAt, id, model: conn.profile.model, text })
		return {
			changeSet,
			meta: {
				llmProfile: {
					id: conn.profile.id,
					provider: conn.profile.provider,
					model: conn.profile.model,
					baseURL: conn.profile.baseURL,
				},
			},
		}
	}
}

declare module '@pluxel/hmr/services' {
	namespace UI {
		interface rpc {
			UniverAI: UniverAIRpc
		}
	}
}
