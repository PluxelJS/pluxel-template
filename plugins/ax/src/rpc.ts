import { RpcTarget } from '@pluxel/hmr/capnweb'

import type { AxHub } from './hub'

export type CreateProfileInput = {
	title?: string
	provider: string
	model?: string
	apiURL?: string
	config?: Record<string, unknown>
	options?: Record<string, unknown>
	apiKey?: string
	makeDefault?: boolean
}

export type UpdateProfileInput = Partial<Omit<CreateProfileInput, 'apiKey'>> & {
	enabled?: boolean
}

export type AxHubRequest =
	| { type: 'profiles:list' }
	| { type: 'profiles:create'; input: CreateProfileInput }
	| { type: 'profiles:update'; id: string; input: UpdateProfileInput }
	| { type: 'profiles:setDefault'; id: string }
	| { type: 'profiles:delete'; id: string }
	| { type: 'profiles:setApiKey'; id: string; apiKey: string }
	| { type: 'profiles:clearApiKey'; id: string }

type AxHubRequestMap = {
	'profiles:list': Awaited<ReturnType<AxHub['listProfiles']>>
	'profiles:create': Awaited<ReturnType<AxHub['createProfile']>>
	'profiles:update': Awaited<ReturnType<AxHub['updateProfile']>>
	'profiles:setDefault': void
	'profiles:delete': void
	'profiles:setApiKey': Awaited<ReturnType<AxHub['setApiKey']>>
	'profiles:clearApiKey': Awaited<ReturnType<AxHub['clearApiKey']>>
}

export type AxHubResponse<T extends AxHubRequest> = AxHubRequestMap[T['type']]

export class AxHubRpc extends RpcTarget {
	constructor(private readonly plugin: AxHub) {
		super()
	}

	request<T extends AxHubRequest>(req: T): Promise<AxHubResponse<T>> {
		switch (req.type) {
			case 'profiles:list':
				return this.plugin.listProfiles() as Promise<AxHubResponse<T>>
			case 'profiles:create':
				return this.plugin.createProfile(req.input) as Promise<AxHubResponse<T>>
			case 'profiles:update':
				return this.plugin.updateProfile(req.id, req.input) as Promise<AxHubResponse<T>>
			case 'profiles:setDefault':
				return this.plugin.setDefaultProfile(req.id) as Promise<AxHubResponse<T>>
			case 'profiles:delete':
				return this.plugin.deleteProfile(req.id) as Promise<AxHubResponse<T>>
			case 'profiles:setApiKey':
				return this.plugin.setApiKey(req.id, req.apiKey) as Promise<AxHubResponse<T>>
			case 'profiles:clearApiKey':
				return this.plugin.clearApiKey(req.id) as Promise<AxHubResponse<T>>
			default: {
				const _exhaustive: never = req
				throw new Error(`[ax] unknown request: ${String((_exhaustive as { type?: unknown }).type)}`)
			}
		}
	}

	/** @deprecated Use `request({ type: 'profiles:list' })`. */
	profiles() {
		return this.request({ type: 'profiles:list' })
	}

	/** @deprecated Use `request({ type: 'profiles:create', input })`. */
	createProfile(input: CreateProfileInput) {
		return this.request({ type: 'profiles:create', input })
	}

	/** @deprecated Use `request({ type: 'profiles:update', id, input })`. */
	updateProfile(id: string, input: UpdateProfileInput) {
		return this.request({ type: 'profiles:update', id, input })
	}

	/** @deprecated Use `request({ type: 'profiles:setDefault', id })`. */
	setDefaultProfile(id: string) {
		return this.request({ type: 'profiles:setDefault', id })
	}

	/** @deprecated Use `request({ type: 'profiles:delete', id })`. */
	deleteProfile(id: string) {
		return this.request({ type: 'profiles:delete', id })
	}

	/** @deprecated Use `request({ type: 'profiles:setApiKey', id, apiKey })`. */
	setApiKey(id: string, apiKey: string) {
		return this.request({ type: 'profiles:setApiKey', id, apiKey })
	}

	/** @deprecated Use `request({ type: 'profiles:clearApiKey', id })`. */
	clearApiKey(id: string) {
		return this.request({ type: 'profiles:clearApiKey', id })
	}
}

declare module '@pluxel/hmr/services' {
	namespace UI {
		interface rpc {
			Ax: AxHubRpc
		}
	}
}
