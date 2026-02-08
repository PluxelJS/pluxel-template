import '@pluxel/hmr/services'
import { describe, expect, it } from 'vitest'
import { withHost } from '@pluxel/test'

import { LLM } from 'pluxel-plugin-llm-hub'
import { LLMHub } from 'pluxel-plugin-llm-hub'
import { LangChain, LangChainService } from '../src'

describe('pluxel-plugin-langchain: hub adapter', () => {
	it('constructs a chat model via llm-hub routing', async () => {
		await withHost(async (host) => {
			host.add(LLMHub)
			host.add(LangChainService)
			await host.commit()

			const hub = host.require(LLMHub)
			await hub.createProfile({ provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o-mini' })

			const lc = host.require(LangChain)
			const { model, meta } = await lc.resolveChat()
			expect(model).toBeTruthy()
			expect(meta.llmProfile.provider).toBe('openai')
			expect(meta.effective.providerId).toBe('openai')
		})
	})

	it('constructs a chat model from an already-resolved connection', async () => {
		await withHost(async (host) => {
			host.add(LLMHub)
			host.add(LangChainService)
			await host.commit()

			const hub = host.require(LLMHub)
			await hub.createProfile({ provider: 'openai', apiKey: 'sk-test', model: 'gpt-4o-mini' })

			const conn = await host.require(LLM).connection()
			const lc = host.require(LangChain)

			const { model, meta } = await lc.resolveChatFromConnection(conn)
			expect(model).toBeTruthy()
			expect(meta.llmProfile.id).toBe(conn.profile.id)
		})
	})
})
