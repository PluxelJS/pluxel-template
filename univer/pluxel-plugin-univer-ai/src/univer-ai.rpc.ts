import { RpcTarget } from '@pluxel/hmr/capnweb'
import { ax } from '@ax-llm/ax'
import { formatStructured } from '@pluxel/promptkit/toon'
import { LLM } from 'pluxel-plugin-llm-hub'
import { createAxAIFromConnection } from 'pluxel-plugin-llm-hub/adapters/ax'
import { randomUUID } from 'node:crypto'

import { buildSuggestEditsPrompt } from './univer-ai.prompt'
import { parseChangeSetJsonText } from './univer-ai.parse'
import type { UniverAiContext, UniverAiSuggestEditsInput, UniverAiSuggestEditsResult } from './univer-ai.types'

function decodeContext(input: UniverAiSuggestEditsInput): UniverAiContext | null {
	if (input.context.format !== 'json') return null
	try {
		return JSON.parse(input.context.text) as UniverAiContext
	} catch {
		return null
	}
}

export class UniverAIRpc extends RpcTarget {
	constructor(private readonly llm: LLM) {
		super()
	}

	async suggestEdits(input: UniverAiSuggestEditsInput): Promise<UniverAiSuggestEditsResult> {
		const createdAt = Date.now()
		const id = randomUUID()

		const decoded = decodeContext(input)
		const structured = decoded ?? { workbookId: input.workbookId }
		const ctxToon = formatStructured(structured, { format: 'toon' })

		const prompt = buildSuggestEditsPrompt(
			{
				...input,
				context: ctxToon,
			},
			ctxToon.text,
		)

		const ai = createAxAIFromConnection(await this.llm.connection())
		const gen = ax('prompt:string -> out:string')
		const out = await gen.forward(ai, { prompt })

		const text = typeof (out as any)?.out === 'string' ? (out as any).out : JSON.stringify(out)
		const changeSet = parseChangeSetJsonText({ workbookId: input.workbookId, createdAt, id, text })
		return { changeSet }
	}
}

declare module '@pluxel/hmr/services' {
	namespace UI {
		interface rpc {
			UniverAI: UniverAIRpc
		}
	}
}
