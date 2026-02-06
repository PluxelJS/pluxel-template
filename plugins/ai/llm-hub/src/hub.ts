import { Plugin } from '@pluxel/hmr'
import { Collection, createIndex } from '@pluxel/hmr/signaldb'

import type { LLMConnection, LLMConnectionOptions, LLMResolvedProfile } from './core'
import { LLM } from './core'
import type { LLMError } from './errors'
import { asLLMError, asLLMErrorResult, llmErr, llmError, llmErrorToError } from './errors'
import type { Result } from './result'
import { err, ok } from './result'
import type { LLMCircuitConfig, LLMProfileDoc, LLMProfileHealth, LLMProfileId, LLMProfilePublic } from './profiles'
import { LLM_COLLECTION_PROFILES, createProfileId, defaultHealth, llmVaultKeyForProfile, maskToken, toPublicProfile } from './profiles'
import type { CreateProfileInput, UpdateProfileInput, UpdateSettingsInput } from './rpc'
import type { LLMHubSettingsDoc } from './settings'
import { LLM_COLLECTION_SETTINGS, defaultSettings } from './settings'

import { effectiveCircuitConfig, effectiveHealth, healthOnFailure, healthOnSuccess, isCircuitOpen, isFailureStatus } from './internal/health'
import { normalizeCircuitConfig, normalizeObject, normalizeOptionalString, normalizePriority, normalizeRequiredString } from './internal/input'
import { migrateLegacyProfiles } from './internal/migrations'
import { normalizeProfileDoc, sortCandidates } from './internal/selection'
import { registerLLMHubExtensions } from './extensions'

const hasOwn = (obj: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(obj, key)

@Plugin(LLM, { name: 'LLMHub', type: 'service' })
export class LLMHub extends LLM {
	private profiles!: Collection<LLMProfileDoc>
	private settings!: Collection<LLMHubSettingsDoc>
	private readyPromise: Promise<void> | null = null

	override async init() {
		this.profiles = new Collection<LLMProfileDoc>({
			name: LLM_COLLECTION_PROFILES,
			persistence: await this.ctx.pluginData.persistenceForCollection<LLMProfileDoc>(LLM_COLLECTION_PROFILES),
			indices: [createIndex('enabled'), createIndex('isDefault'), createIndex('updatedAt')],
		})
		this.settings = new Collection<LLMHubSettingsDoc>({
			name: LLM_COLLECTION_SETTINGS,
			persistence: await this.ctx.pluginData.persistenceForCollection<LLMHubSettingsDoc>(LLM_COLLECTION_SETTINGS),
			indices: [createIndex('updatedAt')],
		})

		this.readyPromise = Promise.all([this.profiles.isReady(), this.settings.isReady()]).then(() => {})
		await this.whenReady()
		migrateLegacyProfiles(this.profiles)
		this.ensureSettingsDoc()
		registerLLMHubExtensions({ ctx: this.ctx, hub: this })
	}

	private async whenReady() {
		await (this.readyPromise ?? Promise.resolve())
	}

	private ensureSettingsDoc() {
		const cur = this.settings.findOne({ id: 'default' })
		if (cur) return
		this.settings.insert(defaultSettings())
	}

	private getSettings(): LLMHubSettingsDoc {
		return this.settings.findOne({ id: 'default' }) ?? defaultSettings()
	}

	private resolveProfileByIdResult(id: string): Result<LLMProfileDoc, LLMError> {
		const pid = String(id ?? '').trim()
		if (!pid) return llmErr('E_INVALID_INPUT', 'profileId must be non-empty')
		const p = this.profiles.findOne({ id: pid })
		if (!p) return llmErr('E_PROFILE_NOT_FOUND', `profile not found: ${pid}`)
		if (!p.enabled) return llmErr('E_PROFILE_DISABLED', `profile disabled: ${pid}`)
		return ok(normalizeProfileDoc(p))
	}

	private resolveCandidates(): LLMProfileDoc[] {
		return this.profiles.find({ enabled: true }).fetch()
	}

	private async readApiKeyResult(profileId: string): Promise<Result<string, LLMError>> {
		try {
			const key = llmVaultKeyForProfile(profileId)
			const token = await this.ctx.vault.open().getToken(key)
			if (!token || !String(token).trim()) return llmErr('E_MISSING_API_KEY', 'missing apiKey (set it in LLM UI)')
			return ok(String(token).trim())
		} catch (e) {
			return llmErr('E_INTERNAL', asLLMError(e).message)
		}
	}

	private async hasApiKey(profileId: string): Promise<boolean> {
		const key = llmVaultKeyForProfile(profileId)
		const token = await this.ctx.vault.open().getToken(key)
		return !!(token && String(token).trim())
	}

	private createInstrumentedFetch(
		profileId: string,
		circuit: LLMCircuitConfig,
		opts?: Pick<LLMConnectionOptions, 'allowCircuitOpen' | 'traceId' | 'sessionId'>,
	): typeof fetch {
		const baseFetch: typeof fetch | undefined = (globalThis as any).fetch
		if (typeof baseFetch !== 'function') {
			return (async () => {
				throw llmErrorToError(llmError('E_INTERNAL', 'global fetch() is not available'))
			}) as any
		}

		return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const cur = this.profiles.findOne({ id: profileId })
			if (!opts?.allowCircuitOpen && cur && circuit.enabled && isCircuitOpen(effectiveHealth(cur))) {
				throw llmErrorToError(llmError('E_CIRCUIT_OPEN', `circuit open: ${profileId}`, { profileId }))
			}

			const traceId = opts?.traceId
			const sessionId = opts?.sessionId
			const nextInit: RequestInit = init && typeof init === 'object' ? { ...(init as RequestInit) } : {}
			if (traceId || sessionId) {
				try {
					const h = new Headers(nextInit.headers ?? undefined)
					if (traceId && !h.has('x-pluxel-trace-id')) h.set('x-pluxel-trace-id', String(traceId))
					if (sessionId && !h.has('x-pluxel-session-id')) h.set('x-pluxel-session-id', String(sessionId))
					nextInit.headers = h
				} catch {
					// best-effort only
				}
			}

			try {
				const res = await baseFetch(input, nextInit)
				if (res && typeof res.status === 'number' && isFailureStatus(res.status)) {
					await this.recordFailure(profileId, {
						code: res.status === 429 ? 'RATE_LIMIT' : res.status === 401 || res.status === 403 ? 'AUTH' : `HTTP_${res.status}`,
						message: `upstream http ${res.status}`,
					})
				} else if (res && typeof res.status === 'number' && res.status >= 200 && res.status < 300) {
					await this.recordSuccess(profileId)
				}
				return res
			} catch (e: any) {
				const name = typeof e?.name === 'string' ? e.name : ''
				const code = name === 'AbortError' ? 'ABORTED' : 'NETWORK'
				const message = typeof e?.message === 'string' ? e.message : String(e)
				await this.recordFailure(profileId, { code, message })
				throw e
			}
		}) as typeof fetch
	}

	private async recordSuccess(profileId: string): Promise<void> {
		const doc = this.profiles.findOne({ id: profileId })
		if (!doc) return

		const now = Date.now()
		const next = healthOnSuccess(effectiveHealth(doc), now)
		if (!next) return

		this.profiles.updateOne(
			{ id: profileId },
			{
				$set: {
					health: next satisfies LLMProfileHealth,
					updatedAt: now,
				},
			} as any,
		)
	}

	private async recordFailure(profileId: string, failure: { code: string; message: string }): Promise<void> {
		const doc = this.profiles.findOne({ id: profileId })
		if (!doc) return

		const settings = this.getSettings()
		const circuit = effectiveCircuitConfig(doc, settings)
		const now = Date.now()
		const next = healthOnFailure(effectiveHealth(doc), circuit, failure, now)

		this.profiles.updateOne(
			{ id: profileId },
			{
				$set: {
					health: next,
					updatedAt: now,
				},
			} as any,
		)
	}

	private toResolvedProfile(doc: LLMProfileDoc): LLMResolvedProfile {
		return {
			id: doc.id,
			title: doc.title,
			provider: doc.provider,
			model: doc.model,
			baseURL: doc.baseURL,
			config: doc.config ?? {},
			options: doc.options ?? {},
		}
	}

	private async connectionForProfileResult(
		profile: LLMProfileDoc,
		opts: { allowCircuitOpen: boolean; traceId?: string; sessionId?: string },
		settings: LLMHubSettingsDoc,
	): Promise<Result<LLMConnection, LLMError>> {
		const circuit = effectiveCircuitConfig(profile, settings)
		if (!opts.allowCircuitOpen && circuit.enabled && isCircuitOpen(effectiveHealth(profile))) {
			return llmErr('E_CIRCUIT_OPEN', `circuit open: ${profile.id}`, {
				profileId: profile.id,
				openUntil: effectiveHealth(profile).openUntil,
			})
		}

		const apiKeyRes = await this.readApiKeyResult(profile.id)
		if (!apiKeyRes.ok) return err(apiKeyRes.err)

		return ok({
			profile: this.toResolvedProfile(profile),
			apiKey: apiKeyRes.val,
			fetch: this.createInstrumentedFetch(profile.id, circuit, {
				allowCircuitOpen: opts.allowCircuitOpen,
				traceId: opts.traceId,
				sessionId: opts.sessionId,
			}),
		})
	}

	override async connectionResult(opts?: LLMConnectionOptions): Promise<Result<LLMConnection, LLMError>> {
		await this.whenReady()

		const settings = this.getSettings()
		const allowCircuitOpen = !!opts?.allowCircuitOpen
		const traceId = opts?.traceId
		const sessionId = opts?.sessionId

		if (opts?.profileId) {
			const resolved = this.resolveProfileByIdResult(opts.profileId)
			if (!resolved.ok) return err(resolved.err)
			return await this.connectionForProfileResult(
				resolved.val,
				{
					allowCircuitOpen,
					traceId,
					sessionId,
				},
				settings,
			)
		}

		const mode = settings.selection?.mode ?? 'default-first'
		const allowFallback = opts?.allowFallback !== false && (settings.selection?.fallback ?? true)
		const candidates = sortCandidates(mode, this.resolveCandidates())

		if (candidates.length === 0) return llmErr('E_NO_DEFAULT_PROFILE', 'no profiles (create one in LLM UI)')

		const tried: Array<{ profileId: string; err: LLMError }> = []

		for (const p of candidates) {
			const res = await this.connectionForProfileResult(
				p,
				{
					allowCircuitOpen,
					traceId,
					sessionId,
				},
				settings,
			)
			if (res.ok) return res

			tried.push({ profileId: p.id, err: res.err })
			if (!allowFallback) return res
		}

		if (tried.length === 1) return err(tried[0]!.err)

		return llmErr('E_PROVIDER_UNAVAILABLE', 'no usable profile (see LLM UI for details)', {
			tried: tried.map((t) => ({ profileId: t.profileId, code: t.err.code, message: t.err.message })),
		})
	}

	async getSettingsResult(): Promise<Result<LLMHubSettingsDoc, LLMError>> {
		await this.whenReady()
		try {
			return ok(this.getSettings())
		} catch (e) {
			return asLLMErrorResult(e, 'failed to read settings')
		}
	}

	async updateSettingsResult(input: UpdateSettingsInput): Promise<Result<LLMHubSettingsDoc, LLMError>> {
		await this.whenReady()
		try {
			const cur = this.getSettings()
			const now = Date.now()
			const next: LLMHubSettingsDoc = {
				...cur,
				selection: {
					mode:
						input.selection?.mode === 'default-first' || input.selection?.mode === 'priority-first'
							? input.selection.mode
							: cur.selection.mode,
					fallback: typeof input.selection?.fallback === 'boolean' ? input.selection.fallback : cur.selection.fallback,
				},
				circuit: {
					...cur.circuit,
					...(normalizeCircuitConfig(input.circuit) ?? {}),
				},
				updatedAt: now,
			}
			this.settings.updateOne({ id: 'default' }, { $set: next as any })
			return ok(this.getSettings())
		} catch (e) {
			return asLLMErrorResult(e, 'failed to update settings')
		}
	}

	async listProfilesResult(): Promise<Result<LLMProfilePublic[], LLMError>> {
		await this.whenReady()
		try {
			const list = this.profiles
				.find()
				.fetch()
				.slice()
				.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))

			const vault = this.ctx.vault.open()
			const has = async (id: string) => {
				const token = await vault.getToken(llmVaultKeyForProfile(id))
				return !!(token && String(token).trim())
			}

			const publicList = await Promise.all(list.map(async (p) => toPublicProfile(normalizeProfileDoc(p), await has(p.id))))
			return ok(publicList)
		} catch (e) {
			return asLLMErrorResult(e, 'failed to list profiles')
		}
	}

	async listProfiles(): Promise<LLMProfilePublic[]> {
		const res = await this.listProfilesResult()
		if (!res.ok) throw llmErrorToError(res.err)
		return res.val
	}

	async createProfileResult(input: CreateProfileInput): Promise<Result<LLMProfilePublic, LLMError>> {
		await this.whenReady()
		try {
			const now = Date.now()
			const id = createProfileId()

			const provider = normalizeRequiredString('provider', input.provider)
			const model = normalizeOptionalString(input.model)
			const baseURL = normalizeOptionalString(input.baseURL)
			const title = normalizeOptionalString(input.title)
			const priority = normalizePriority(input.priority)
			const config = normalizeObject('config', input.config)
			const options = normalizeObject('options', input.options)
			const makeDefault = input.makeDefault !== false
			const circuit = normalizeCircuitConfig(input.circuit)

			const apiKey = String(input.apiKey ?? '').trim()
			if (apiKey) await this.ctx.vault.open().setToken(llmVaultKeyForProfile(id), apiKey)

			const doc: LLMProfileDoc = {
				id,
				enabled: true,
				isDefault: false,
				priority,
				title,
				provider,
				...(model ? { model } : {}),
				...(baseURL ? { baseURL } : {}),
				config,
				options,
				...(circuit ? { circuit } : {}),
				health: defaultHealth(),
				...(apiKey ? { apiKeyPreview: maskToken(apiKey) } : {}),
				createdAt: now,
				updatedAt: now,
			}

			this.profiles.insert(doc)

			if (makeDefault || !this.profiles.findOne({ isDefault: true, enabled: true })) {
				const def = await this.setDefaultProfileResult(id)
				if (!def.ok) return err(def.err)
			}

			const latest = this.profiles.findOne({ id })!
			return ok(toPublicProfile(normalizeProfileDoc(latest), await this.hasApiKey(id)))
		} catch (e) {
			return asLLMErrorResult(e, 'failed to create profile')
		}
	}

	async createProfile(input: CreateProfileInput): Promise<LLMProfilePublic> {
		const res = await this.createProfileResult(input)
		if (!res.ok) throw llmErrorToError(res.err)
		return res.val
	}

	async updateProfileResult(id: LLMProfileId, input: UpdateProfileInput): Promise<Result<LLMProfilePublic, LLMError>> {
		await this.whenReady()
		try {
			const doc = this.profiles.findOne({ id })
			if (!doc) return llmErr('E_PROFILE_NOT_FOUND', `profile not found: ${id}`)

			const now = Date.now()
			const next: Partial<LLMProfileDoc> = { updatedAt: now }

			if (hasOwn(input, 'priority')) next.priority = normalizePriority(input.priority)
			if (hasOwn(input, 'circuit')) next.circuit = normalizeCircuitConfig(input.circuit)
			if (hasOwn(input, 'enabled')) next.enabled = !!input.enabled
			if (hasOwn(input, 'title')) next.title = normalizeOptionalString(input.title)
			if (hasOwn(input, 'provider')) next.provider = normalizeRequiredString('provider', input.provider)
			if (hasOwn(input, 'model')) next.model = normalizeOptionalString(input.model)
			if (hasOwn(input, 'baseURL')) next.baseURL = normalizeOptionalString(input.baseURL)
			if (hasOwn(input, 'config')) next.config = normalizeObject('config', input.config)
			if (hasOwn(input, 'options')) next.options = normalizeObject('options', input.options)

			this.profiles.updateOne({ id }, { $set: next as any })

			const updated = this.profiles.findOne({ id })!
			if (updated.isDefault && !updated.enabled) {
				const nextDefault = this.profiles.findOne({ enabled: true })
				if (nextDefault) {
					const def = await this.setDefaultProfileResult(nextDefault.id)
					if (!def.ok) return err(def.err)
				}
			}

			const latest = this.profiles.findOne({ id })!
			return ok(toPublicProfile(normalizeProfileDoc(latest), await this.hasApiKey(id)))
		} catch (e) {
			return asLLMErrorResult(e, 'failed to update profile')
		}
	}

	async updateProfile(id: LLMProfileId, input: UpdateProfileInput): Promise<LLMProfilePublic> {
		const res = await this.updateProfileResult(id, input)
		if (!res.ok) throw llmErrorToError(res.err)
		return res.val
	}

	private async ensureDefaultConsistency(defaultId: string): Promise<void> {
		const all = this.profiles.find().fetch()
		for (const p of all) {
			const shouldBeDefault = p.id === defaultId
			if ((p.isDefault ?? false) !== shouldBeDefault) {
				this.profiles.updateOne({ id: p.id }, { $set: { isDefault: shouldBeDefault, updatedAt: Date.now() } })
			}
		}
	}

	async setDefaultProfileResult(id: LLMProfileId): Promise<Result<void, LLMError>> {
		await this.whenReady()
		try {
			const doc = this.profiles.findOne({ id })
			if (!doc) return llmErr('E_PROFILE_NOT_FOUND', `profile not found: ${id}`)
			if (!doc.enabled) return llmErr('E_PROFILE_DISABLED', `cannot set disabled profile as default: ${id}`)
			await this.ensureDefaultConsistency(id)
			return ok(undefined)
		} catch (e) {
			return asLLMErrorResult(e, 'failed to set default profile')
		}
	}

	async setDefaultProfile(id: LLMProfileId): Promise<void> {
		const res = await this.setDefaultProfileResult(id)
		if (!res.ok) throw llmErrorToError(res.err)
	}

	async deleteProfileResult(id: LLMProfileId): Promise<Result<void, LLMError>> {
		await this.whenReady()
		try {
			const doc = this.profiles.findOne({ id })
			if (!doc) return ok(undefined)

			this.profiles.removeOne({ id })

			await this.ctx.vault.open().deleteToken(llmVaultKeyForProfile(id)).catch(() => {})

			if (doc.isDefault) {
				const next = this.profiles.findOne({ enabled: true })
				if (next) {
					const def = await this.setDefaultProfileResult(next.id)
					if (!def.ok) return def
				}
			}
			return ok(undefined)
		} catch (e) {
			return asLLMErrorResult(e, 'failed to delete profile')
		}
	}

	async deleteProfile(id: LLMProfileId): Promise<void> {
		const res = await this.deleteProfileResult(id)
		if (!res.ok) throw llmErrorToError(res.err)
	}

	async resetProfileHealthResult(id: LLMProfileId): Promise<Result<LLMProfilePublic, LLMError>> {
		await this.whenReady()
		try {
			const doc = this.profiles.findOne({ id })
			if (!doc) return llmErr('E_PROFILE_NOT_FOUND', `profile not found: ${id}`)
			this.profiles.updateOne({ id }, { $set: { health: defaultHealth(), updatedAt: Date.now() } as any })
			const latest = this.profiles.findOne({ id })!
			return ok(toPublicProfile(normalizeProfileDoc(latest), await this.hasApiKey(id)))
		} catch (e) {
			return asLLMErrorResult(e, 'failed to reset profile health')
		}
	}

	async setApiKeyResult(id: LLMProfileId, apiKey: string): Promise<Result<LLMProfilePublic, LLMError>> {
		await this.whenReady()
		try {
			const trimmed = String(apiKey ?? '').trim()
			if (!trimmed) return llmErr('E_INVALID_INPUT', 'apiKey is required')

			const doc = this.profiles.findOne({ id })
			if (!doc) return llmErr('E_PROFILE_NOT_FOUND', `profile not found: ${id}`)

			await this.ctx.vault.open().setToken(llmVaultKeyForProfile(id), trimmed)
			this.profiles.updateOne({ id }, { $set: { apiKeyPreview: maskToken(trimmed), updatedAt: Date.now() } })

			const updated = this.profiles.findOne({ id })!
			return ok(toPublicProfile(normalizeProfileDoc(updated), true))
		} catch (e) {
			return asLLMErrorResult(e, 'failed to set apiKey')
		}
	}

	async setApiKey(id: LLMProfileId, apiKey: string): Promise<LLMProfilePublic> {
		const res = await this.setApiKeyResult(id, apiKey)
		if (!res.ok) throw llmErrorToError(res.err)
		return res.val
	}

	async clearApiKeyResult(id: LLMProfileId): Promise<Result<LLMProfilePublic, LLMError>> {
		await this.whenReady()
		try {
			const doc = this.profiles.findOne({ id })
			if (!doc) return llmErr('E_PROFILE_NOT_FOUND', `profile not found: ${id}`)

			await this.ctx.vault.open().deleteToken(llmVaultKeyForProfile(id)).catch(() => {})
			this.profiles.updateOne({ id }, { $set: { apiKeyPreview: undefined, updatedAt: Date.now() } })

			const updated = this.profiles.findOne({ id })!
			return ok(toPublicProfile(normalizeProfileDoc(updated), false))
		} catch (e) {
			return asLLMErrorResult(e, 'failed to clear apiKey')
		}
	}

	async clearApiKey(id: LLMProfileId): Promise<LLMProfilePublic> {
		const res = await this.clearApiKeyResult(id)
		if (!res.ok) throw llmErrorToError(res.err)
		return res.val
	}
}

