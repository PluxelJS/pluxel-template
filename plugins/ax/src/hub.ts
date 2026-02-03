import { ai as axAi, type AxAI } from '@ax-llm/ax'
import { Plugin } from '@pluxel/hmr'
import { Collection, createIndex } from '@pluxel/hmr/signaldb'

import type { ExecCtx } from '@pluxel/cmd'

import { Ax } from './core'
import type { AxProfileDoc, AxProfileId, AxProfilePublic } from './profiles'
import { AX_COLLECTION_PROFILES, axVaultKeyForProfile, createProfileId, maskToken, toPublicProfile } from './profiles'
import { registerAxHubExtensions } from './extensions'
import type { CreateProfileInput, UpdateProfileInput } from './rpc'

@Plugin(Ax, { name: 'AxHub', type: 'service' })
export class AxHub extends Ax {
	private profiles!: Collection<AxProfileDoc>
	private readyPromise: Promise<void> | null = null

	private aiByProfileId = new Map<string, Promise<AxAI>>()

	override async init() {
		this.profiles = new Collection<AxProfileDoc>({
			name: AX_COLLECTION_PROFILES,
			persistence: await this.ctx.pluginData.persistenceForCollection<AxProfileDoc>(AX_COLLECTION_PROFILES),
			indices: [createIndex('enabled'), createIndex('isDefault'), createIndex('updatedAt')],
		})
		this.readyPromise = this.profiles.isReady()
		registerAxHubExtensions({ ctx: this.ctx, hub: this })
	}

	private async whenReady() {
		await (this.readyPromise ?? Promise.resolve())
	}

	private normalizeRequiredString(field: string, raw: unknown): string {
		const s = String(raw ?? '').trim()
		if (!s) throw new Error(`[ax] ${field} must be non-empty`)
		return s
	}

	private normalizeOptionalString(raw: unknown): string | undefined {
		const s = typeof raw === 'string' ? raw.trim() : ''
		return s || undefined
	}

	private normalizeObject(field: string, raw: unknown): Record<string, unknown> {
		if (!raw) return {}
		if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`[ax] ${field} must be an object`)
		return raw as any
	}

	private async readApiKey(profileId: string): Promise<string> {
		const key = axVaultKeyForProfile(profileId)
		const token = await this.ctx.vault.open().getToken(key)
		if (!token || !String(token).trim()) throw new Error('[ax] missing apiKey (set it in Ax UI)')
		return String(token).trim()
	}

	private async hasApiKey(profileId: string): Promise<boolean> {
		const key = axVaultKeyForProfile(profileId)
		const token = await this.ctx.vault.open().getToken(key)
		return !!(token && String(token).trim())
	}

	private async ensureDefaultConsistency(defaultId: string): Promise<void> {
		const all = this.profiles.find().fetch()
		for (const p of all) {
			const shouldBeDefault = p.id === defaultId
			if ((p.isDefault ?? false) !== shouldBeDefault) {
				this.profiles.updateOne({ id: p.id }, { $set: { isDefault: shouldBeDefault, updatedAt: Date.now() } })
				this.aiByProfileId.delete(p.id)
			}
		}
	}

	private resolveDefaultProfileId(): string | undefined {
		const p = this.profiles.findOne({ isDefault: true, enabled: true })
		return p?.id
	}

	private resolveProfile(id?: string): AxProfileDoc {
		if (id) {
			const p = this.profiles.findOne({ id })
			if (!p) throw new Error(`[ax] profile not found: ${id}`)
			if (!p.enabled) throw new Error(`[ax] profile disabled: ${id}`)
			return p
		}
		const defaultId = this.resolveDefaultProfileId()
		if (!defaultId) throw new Error('[ax] no default profile (create one in Ax UI)')
		return this.profiles.findOne({ id: defaultId })!
	}

	override async ai(opts?: { profileId?: string; ctx?: ExecCtx }): Promise<AxAI> {
		await this.whenReady()

		const profile = this.resolveProfile(opts?.profileId)
		const cacheKey = profile.id

		let promise = this.aiByProfileId.get(cacheKey)
		if (!promise) {
			promise = (async () => {
				const apiKey = await this.readApiKey(profile.id)
				const provider = this.normalizeRequiredString('provider', profile.provider)
				const model = this.normalizeOptionalString(profile.model)
				const apiURL = this.normalizeOptionalString(profile.apiURL)

				const config = { ...(this.normalizeObject('config', profile.config)), ...(model ? { model } : {}) }
				const options = this.normalizeObject('options', profile.options)

				return axAi({
					name: provider as any,
					apiKey,
					...(apiURL ? { apiURL } : {}),
					...(Object.keys(config).length ? { config: config as any } : {}),
					...(Object.keys(options).length ? { options: options as any } : {}),
				} as any) as any
			})().catch((err) => {
				this.aiByProfileId.delete(cacheKey)
				throw err
			})
			this.aiByProfileId.set(cacheKey, promise)
		}

		return await promise
	}

	async listProfiles(): Promise<AxProfilePublic[]> {
		await this.whenReady()
		const list = this.profiles
			.find()
			.fetch()
			.slice()
			.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))

		const vault = this.ctx.vault.open()
		const has = async (id: string) => {
			const token = await vault.getToken(axVaultKeyForProfile(id))
			return !!(token && String(token).trim())
		}

		return await Promise.all(list.map(async (p) => toPublicProfile(p, await has(p.id))))
	}

	async createProfile(input: CreateProfileInput): Promise<AxProfilePublic> {
		await this.whenReady()

		const now = Date.now()
		const id = createProfileId()

		const provider = this.normalizeRequiredString('provider', input.provider)
		const model = this.normalizeOptionalString(input.model)
		const apiURL = this.normalizeOptionalString(input.apiURL)
		const title = this.normalizeOptionalString(input.title)
		const config = this.normalizeObject('config', input.config)
		const options = this.normalizeObject('options', input.options)
		const makeDefault = input.makeDefault !== false

		const apiKey = String(input.apiKey ?? '').trim()
		const hasApiKey = !!apiKey
		if (apiKey) await this.ctx.vault.open().setToken(axVaultKeyForProfile(id), apiKey)

		const doc: AxProfileDoc = {
			id,
			enabled: true,
			isDefault: false,
			title,
			provider,
			...(model ? { model } : {}),
			...(apiURL ? { apiURL } : {}),
			config,
			options,
			...(apiKey ? { apiKeyPreview: maskToken(apiKey) } : {}),
			createdAt: now,
			updatedAt: now,
		}

		this.profiles.insert(doc)
		this.aiByProfileId.delete(id)

		if (makeDefault || !this.resolveDefaultProfileId()) {
			await this.setDefaultProfile(id)
		}

		const latest = this.profiles.findOne({ id })!
		return toPublicProfile(latest, await this.hasApiKey(id))
	}

	async updateProfile(id: AxProfileId, input: UpdateProfileInput): Promise<AxProfilePublic> {
		await this.whenReady()
		const doc = this.profiles.findOne({ id })
		if (!doc) throw new Error(`[ax] profile not found: ${id}`)

		const now = Date.now()
		const next: Partial<AxProfileDoc> = {
			updatedAt: now,
		}

		if (input.enabled !== undefined) next.enabled = !!input.enabled
		if (input.title !== undefined) next.title = this.normalizeOptionalString(input.title)
		if (input.provider !== undefined) next.provider = this.normalizeRequiredString('provider', input.provider)
		if (input.model !== undefined) next.model = this.normalizeOptionalString(input.model)
		if (input.apiURL !== undefined) next.apiURL = this.normalizeOptionalString(input.apiURL)
		if (input.config !== undefined) next.config = this.normalizeObject('config', input.config)
		if (input.options !== undefined) next.options = this.normalizeObject('options', input.options)

		this.profiles.updateOne({ id }, { $set: next as any })
		this.aiByProfileId.delete(id)

		const updated = this.profiles.findOne({ id })!
		if (updated.isDefault && !updated.enabled) {
			const nextDefault = this.profiles.findOne({ enabled: true })
			if (nextDefault) await this.setDefaultProfile(nextDefault.id)
		}

		const latest = this.profiles.findOne({ id })!
		return toPublicProfile(latest, await this.hasApiKey(id))
	}

	async setDefaultProfile(id: AxProfileId): Promise<void> {
		await this.whenReady()
		const doc = this.profiles.findOne({ id })
		if (!doc) throw new Error(`[ax] profile not found: ${id}`)
		if (!doc.enabled) throw new Error(`[ax] cannot set disabled profile as default: ${id}`)
		await this.ensureDefaultConsistency(id)
	}

	async deleteProfile(id: AxProfileId): Promise<void> {
		await this.whenReady()
		const doc = this.profiles.findOne({ id })
		if (!doc) return

		this.profiles.removeOne({ id })
		this.aiByProfileId.delete(id)

		await this.ctx.vault.open().deleteToken(axVaultKeyForProfile(id)).catch(() => {})

		if (doc.isDefault) {
			const next = this.profiles.findOne({ enabled: true })
			if (next) await this.setDefaultProfile(next.id)
		}
	}

	async setApiKey(id: AxProfileId, apiKey: string): Promise<AxProfilePublic> {
		await this.whenReady()
		const trimmed = String(apiKey ?? '').trim()
		if (!trimmed) throw new Error('[ax] apiKey is required')

		const doc = this.profiles.findOne({ id })
		if (!doc) throw new Error(`[ax] profile not found: ${id}`)

		await this.ctx.vault.open().setToken(axVaultKeyForProfile(id), trimmed)
		this.profiles.updateOne({ id }, { $set: { apiKeyPreview: maskToken(trimmed), updatedAt: Date.now() } })
		this.aiByProfileId.delete(id)

		const updated = this.profiles.findOne({ id })!
		return toPublicProfile(updated, true)
	}

	async clearApiKey(id: AxProfileId): Promise<AxProfilePublic> {
		await this.whenReady()
		const doc = this.profiles.findOne({ id })
		if (!doc) throw new Error(`[ax] profile not found: ${id}`)

		await this.ctx.vault.open().deleteToken(axVaultKeyForProfile(id)).catch(() => {})
		this.profiles.updateOne({ id }, { $set: { apiKeyPreview: undefined, updatedAt: Date.now() } })
		this.aiByProfileId.delete(id)

		const updated = this.profiles.findOne({ id })!
		return toPublicProfile(updated, false)
	}
}
