import type { AxAI } from '@ax-llm/ax'
import { AxAIProvider } from '@ax-llm/ax-ai-sdk-provider'

import type { LLM, LLMConnection, LLMConnectionOptions } from '../core'
import type { CreateAxAIOverrides } from './ax'
import { createAxAIFromConnection } from './ax'

export type CreateAxAISDKProviderOverrides = CreateAxAIOverrides

export function createAxAISDKProviderFromAxAI(axAI: AxAI): AxAIProvider {
	return new AxAIProvider(axAI)
}

export function createAxAISDKProviderFromConnection(conn: LLMConnection, overrides?: CreateAxAISDKProviderOverrides): AxAIProvider {
	return createAxAISDKProviderFromAxAI(createAxAIFromConnection(conn, overrides))
}

export async function createAxAISDKProviderFromLLM(
	llm: LLM,
	opts?: LLMConnectionOptions,
	overrides?: CreateAxAISDKProviderOverrides,
): Promise<AxAIProvider> {
	const conn = await llm.connection(opts)
	return createAxAISDKProviderFromConnection(conn, overrides)
}

