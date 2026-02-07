import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { BasePlugin, Plugin, type Config } from '@pluxel/hmr'
import { v } from '@pluxel/hmr/config'
import Tinypool from 'tinypool'

import type {
	MemeImageResult,
	MemeMetadata,
	MemeRenderPayload,
	MemeRenderResult,
	MemeResolveResult,
	MemeWorkerJob,
} from './types'
export type * from 'pluxel-plugin-napi-rs/meme-generator'
import { registerMemeWorkerWeb } from './web/memes'
export { registerMemeWorkerWeb } from './web/memes'

type MemeModule = typeof import('pluxel-plugin-napi-rs/meme-generator')

const DEFAULT_IDLE_TIMEOUT = 30_000
const workerEntryCandidates = ['worker.js', 'worker.mjs']

const CfgSchema = v.object({
	maxThreads: v.optional(v.number()),
	idleTimeout: v.optional(v.number(), DEFAULT_IDLE_TIMEOUT),
})

function resolveWorkerEntrypoint(): string {
	const currentDir = path.dirname(fileURLToPath(import.meta.url))
	const pkgRoot = path.resolve(currentDir, '..')
	const candidates = [
		...workerEntryCandidates.map((file) => path.join(currentDir, file)),
		...workerEntryCandidates.map((file) => path.join(pkgRoot, 'dist', file)),
	]

	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			return pathToFileURL(candidate).href
		}
	}

	throw new Error(
		`[meme-worker] worker bundle not found. Tried: ${candidates.join(', ')}. Run "pnpm --filter pluxel-plugin-meme-worker build" first.`,
	)
}

@Plugin({ name: 'MemeWorker', type: 'service' })
export class MemeWorker extends BasePlugin {
	private config: Config<typeof CfgSchema> = this.configs.use(CfgSchema)

	private pool: Tinypool | null = null
	private poolInitPromise: Promise<void> | null = null
	private readyPromise: Promise<void> | null = null
	private memeLib: MemeModule | null = null
	private memeLibPromise: Promise<MemeModule> | null = null
	private workerEntrypointFallback: string | null = null
	private workerEntrypoint: string | null = null
	private keywordIndex: Map<string, string> | null = null

	override async init(): Promise<void> {
			// Default to /meme-test for backwards compatibility with existing links.
			// Downstream plugins can mount their own routes if they want a different prefix.
			registerMemeWorkerWeb(this.ctx, this)
		
		// Do not block plugin startup on native binding download / resource checks / worker compilation.
		void this.ensurePool().catch((e) => {
			const error = e instanceof Error ? e : new Error(String(e))
			this.ctx.logger.warn('warmup failed', { error })
		})
		this.ctx.logger.info('started')
	}

	override async stop(): Promise<void> {
		if (!this.pool && this.poolInitPromise) {
			// Wait for in-flight pool creation before attempting destroy
			await this.poolInitPromise
		}

		if (this.pool) {
			await this.pool.destroy()
			this.pool = null
		}
		this.ctx.logger.info('stopped')
	}

	async generateRaw(payload: MemeRenderPayload): Promise<MemeRenderResult> {
		return this.run({ kind: 'meme', payload })
	}

	async generateImage(payload: MemeRenderPayload): Promise<MemeImageResult> {
		const res = await this.generateRaw(payload)
		if (!res.ok) {
			return { ok: false, message: res.message, durationMs: res.durationMs }
		}
		const buffer = Buffer.from(res.buffer)
		const mime = detectMime(buffer) ?? 'application/octet-stream'
		return {
			ok: true,
			buffer,
			mime,
			durationMs: res.durationMs,
			meta: res.meta,
		}
	}

	/**
	 * Render a meme list image using meme-generator `Tools.renderMemeList` via the Tinypool worker,
	 * similar to meme rendering.
	 */
	async getMemeListImage(opts?: {
		sortBy?: 'Key' | 'Keywords' | 'KeywordsPinyin' | 'DateCreated' | 'DateModified'
		sortReverse?: boolean
		textTemplate?: string
		addCategoryIcon?: boolean
	}): Promise<MemeImageResult> {
		const res = await this.run({ kind: 'listImage', payload: opts ?? {} })
		if (!res.ok) return { ok: false, message: res.message, durationMs: res.durationMs }
		const buffer = Buffer.from(res.buffer)
		const mime = detectMime(buffer) ?? 'application/octet-stream'
		return { ok: true, buffer, mime, durationMs: res.durationMs, meta: { key: 'meme-list' } }
	}

	/**
	 * Ensure native meme-generator is loaded and ready to serve metadata queries.
	 * (Generation methods already ensure worker pool.)
	 */
	ready(): Promise<void> {
		return this.ensureReady()
	}

	listKeys(): string[] {
		return this.requireMemeLib().getMemeKeys()
	}

	getMemeInfo(key: string): MemeMetadata | null {
		const meme = this.requireMemeLib().getMeme(key)
		return meme?.info ?? null
	}

	search(query: string, includeTags = true): string[] {
		return this.requireMemeLib().searchMemes(query, includeTags)
	}

	resolveMeme(identifier: string): MemeResolveResult {
		const normalized = identifier.trim()
		if (!normalized) return null

		if (normalized.toLowerCase() === 'random') {
			const keys = this.listKeys()
			if (!keys.length) return null
			const randomKey = keys[Math.floor(Math.random() * keys.length)]
			const info = this.getMemeInfo(randomKey)
			return info ? { kind: 'exact', info } : null
		}

		const exact = this.getMemeInfo(normalized)
		if (exact) return { kind: 'exact', info: exact }

		const byKeyword = this.resolveKeywordToKey(normalized)
		if (byKeyword) {
			const info = this.getMemeInfo(byKeyword)
			return info ? { kind: 'exact', info } : null
		}

		const matches = this.search(normalized, true)
		if (!matches.length) return null

		if (matches.length === 1) {
			const info = this.getMemeInfo(matches[0])
			return info ? { kind: 'exact', info } : null
		}

		return { kind: 'choices', matches: matches.slice(0, 5) }
	}

	private resolveKeywordToKey(keyword: string): string | null {
		const k = keyword.trim()
		if (!k) return null
		if (!this.keywordIndex) this.keywordIndex = this.buildKeywordIndex()
		return this.keywordIndex.get(k) ?? this.keywordIndex.get(k.toLowerCase()) ?? null
	}

	private buildKeywordIndex(): Map<string, string> {
		const map = new Map<string, string>()
		for (const key of this.listKeys()) {
			const info = this.getMemeInfo(key)
			const keywords: unknown = (info as any)?.keywords
			if (!Array.isArray(keywords)) continue
			for (const kw of keywords) {
				if (typeof kw !== 'string') continue
				const s = kw.trim()
				if (!s) continue
				// Keywords are expected to be unique (like keys); first one wins to keep deterministic behavior.
				if (!map.has(s)) map.set(s, key)
				const lower = s.toLowerCase()
				if (lower !== s && !map.has(lower)) map.set(lower, key)
			}
		}
		return map
	}

	private async run(job: MemeWorkerJob): Promise<MemeRenderResult> {
		await this.ensurePool()
		return this.pool!.run(job)
	}

	private async loadMemeLib(): Promise<MemeModule> {
		if (this.memeLib) return this.memeLib
		if (!this.memeLibPromise) {
			this.memeLibPromise = (async () => {
				// Prefer current working directory cache unless MEME_HOME is already provided.
				const preferRoot = process.env.MEME_HOME || path.join(process.cwd(), 'napi-rs-cache')
				process.env.MEME_HOME = preferRoot
				fs.mkdirSync(preferRoot, { recursive: true })

				const mod = await import('pluxel-plugin-napi-rs/meme-generator')
				this.memeLib = mod
				return mod
			})()
		}

		return this.memeLibPromise
	}

	private requireMemeLib(): MemeModule {
		if (!this.memeLib) {
			throw new Error('[meme-worker] meme generator not initialized yet')
		}
		return this.memeLib
	}

	private ensureReady(): Promise<void> {
		if (!this.readyPromise) {
			// Force native binding to download and resources to be validated once, before workers spawn
			this.readyPromise = (async () => {
				const lib = await this.loadMemeLib()
				const check =
					typeof lib.Resources?.checkResources === 'function'
						? lib.Resources.checkResources
						: typeof (lib as any).checkResources === 'function'
							? (lib as any).checkResources
							: null
				if (check) {
					check()
				}
				if (typeof lib.getVersion === 'function') {
					lib.getVersion()
				}
			})()
		}
		return this.readyPromise
	}

	private async ensurePool(): Promise<void> {
		if (this.pool) return
		if (this.poolInitPromise) return this.poolInitPromise

		this.poolInitPromise = (async () => {
			await this.ensureReady()

				const maxThreads = this.config.maxThreads ?? 1
				const idleTimeout = this.config.idleTimeout ?? DEFAULT_IDLE_TIMEOUT
	
				let filename = this.workerEntrypoint
				if (!filename) {
					try {
						filename = await this.ctx.bundlerService.compileTinypoolWorker('src/worker.ts', {
							external: ['pluxel-plugin-napi-rs/meme-generator'],
						})
					} catch {
						filename = this.workerEntrypointFallback ?? (this.workerEntrypointFallback = resolveWorkerEntrypoint())
					}
					this.workerEntrypoint = filename
				}
	
				this.pool = new Tinypool({
					filename,
					maxThreads,
				idleTimeout,
				concurrentTasksPerWorker: 1,
				isolateWorkers: false,
			})
		})().finally(() => {
			this.poolInitPromise = null
		})

		return this.poolInitPromise
	}
}

export type { MemeRenderPayload, MemeRenderResult, MemeImageResult, MemeMetadata, MemeResolveResult } from './types'

function detectMime(buffer: Buffer): string | null {
	if (buffer.length < 12) return null
	// PNG signature
	if (
		buffer[0] === 0x89 &&
		buffer[1] === 0x50 &&
		buffer[2] === 0x4e &&
		buffer[3] === 0x47 &&
		buffer[4] === 0x0d &&
		buffer[5] === 0x0a &&
		buffer[6] === 0x1a &&
		buffer[7] === 0x0a
	) {
		return 'image/png'
	}
	// GIF87a / GIF89a
	if (buffer.slice(0, 6).toString('ascii') === 'GIF87a' || buffer.slice(0, 6).toString('ascii') === 'GIF89a') {
		return 'image/gif'
	}
	// JPEG
	if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
		return 'image/jpeg'
	}
	// WebP: "RIFF....WEBP"
	if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') {
		return 'image/webp'
	}
	// MP4: ....ftyp
	if (buffer.slice(4, 8).toString('ascii') === 'ftyp') {
		return 'video/mp4'
	}
	return null
}

// (hashStrings removed: Takumi catalog images removed)
