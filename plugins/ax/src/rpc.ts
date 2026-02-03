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

export class AxHubRpc extends RpcTarget {
	constructor(private readonly plugin: AxHub) {
		super()
	}

	profiles() {
		return this.plugin.listProfiles()
	}

	createProfile(input: CreateProfileInput) {
		return this.plugin.createProfile(input)
	}

	updateProfile(id: string, input: UpdateProfileInput) {
		return this.plugin.updateProfile(id, input)
	}

	setDefaultProfile(id: string) {
		return this.plugin.setDefaultProfile(id)
	}

	deleteProfile(id: string) {
		return this.plugin.deleteProfile(id)
	}

	setApiKey(id: string, apiKey: string) {
		return this.plugin.setApiKey(id, apiKey)
	}

	clearApiKey(id: string) {
		return this.plugin.clearApiKey(id)
	}
}

declare module '@pluxel/hmr/services' {
	namespace UI {
		interface rpc {
			Ax: AxHubRpc
		}
	}
}

