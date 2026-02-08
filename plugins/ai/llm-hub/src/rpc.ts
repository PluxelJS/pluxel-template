import { RpcTarget } from '@pluxel/hmr/capnweb'

import type { LLMHub } from './hub'
import type { LLMCircuitConfig } from './profiles'
import type { LLMHubSettingsDoc } from './settings'

export type UpdateSettingsInput = {
	circuit?: Partial<LLMCircuitConfig>
}

export type CreateProfileInput = {
	title?: string
	provider: string
	model?: string
	baseURL?: string
	config?: Record<string, unknown>
	options?: Record<string, unknown>
	apiKey?: string
	priority?: number
	circuit?: Partial<LLMCircuitConfig>
}

export type UpdateProfileInput = Partial<Omit<CreateProfileInput, 'apiKey'>> & {
	enabled?: boolean
}

export type LLMHubRequest =
	| { type: 'profiles:list' }
	| { type: 'profiles:create'; input: CreateProfileInput }
	| { type: 'profiles:update'; id: string; input: UpdateProfileInput }
	| { type: 'profiles:delete'; id: string }
	| { type: 'profiles:resetHealth'; id: string }
	| { type: 'profiles:setApiKey'; id: string; apiKey: string }
	| { type: 'profiles:clearApiKey'; id: string }
	| { type: 'settings:get' }
	| { type: 'settings:update'; input: UpdateSettingsInput }

type LLMHubRequestMap = {
	'profiles:list': Awaited<ReturnType<LLMHub['listProfilesResult']>>
	'profiles:create': Awaited<ReturnType<LLMHub['createProfileResult']>>
	'profiles:update': Awaited<ReturnType<LLMHub['updateProfileResult']>>
	'profiles:delete': Awaited<ReturnType<LLMHub['deleteProfileResult']>>
	'profiles:resetHealth': Awaited<ReturnType<LLMHub['resetProfileHealthResult']>>
	'profiles:setApiKey': Awaited<ReturnType<LLMHub['setApiKeyResult']>>
	'profiles:clearApiKey': Awaited<ReturnType<LLMHub['clearApiKeyResult']>>
	'settings:get': Awaited<ReturnType<LLMHub['getSettingsResult']>>
	'settings:update': Awaited<ReturnType<LLMHub['updateSettingsResult']>>
}

export type LLMHubResponse<T extends LLMHubRequest> = LLMHubRequestMap[T['type']]

export class LLMHubRpc extends RpcTarget {
	constructor(private readonly plugin: LLMHub) {
		super()
	}

	request<T extends LLMHubRequest>(req: T): Promise<LLMHubResponse<T>> {
		switch (req.type) {
			case 'profiles:list':
				return this.plugin.listProfilesResult() as Promise<LLMHubResponse<T>>
			case 'profiles:create':
				return this.plugin.createProfileResult(req.input) as Promise<LLMHubResponse<T>>
			case 'profiles:update':
				return this.plugin.updateProfileResult(req.id, req.input) as Promise<LLMHubResponse<T>>
			case 'profiles:delete':
				return this.plugin.deleteProfileResult(req.id) as Promise<LLMHubResponse<T>>
			case 'profiles:resetHealth':
				return this.plugin.resetProfileHealthResult(req.id) as Promise<LLMHubResponse<T>>
			case 'profiles:setApiKey':
				return this.plugin.setApiKeyResult(req.id, req.apiKey) as Promise<LLMHubResponse<T>>
			case 'profiles:clearApiKey':
				return this.plugin.clearApiKeyResult(req.id) as Promise<LLMHubResponse<T>>
			case 'settings:get':
				return this.plugin.getSettingsResult() as Promise<LLMHubResponse<T>>
			case 'settings:update':
				return this.plugin.updateSettingsResult(req.input) as Promise<LLMHubResponse<T>>
			default: {
				const _exhaustive: never = req
				throw new Error(`[llm] unknown request: ${String((_exhaustive as { type?: unknown }).type)}`)
			}
		}
	}
}

declare module '@pluxel/hmr/services' {
	namespace UI {
		interface rpc {
			LLMHub: LLMHubRpc
		}
	}
}
