import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { BasePlugin, Config, Plugin } from '@pluxel/hmr'
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
	@Config(CfgSchema)
	private config!: Config<typeof CfgSchema>

	private pool: Tinypool | null = null
	private poolInitPromise: Promise<void> | null = null
	private readyPromise: Promise<void> | null = null
	private memeLib: MemeModule | null = null
	private memeLibPromise: Promise<MemeModule> | null = null
	private readonly workerEntrypoint = resolveWorkerEntrypoint()

	override async init(): Promise<void> {
		await this.ensurePool()
		this.ctx.logger.info('[meme-worker] ready')
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
		this.ctx.logger.info('[meme-worker] stopped')
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
		const mime = 'image/png'
		return {
			ok: true,
			buffer,
			mime,
			durationMs: res.durationMs,
			meta: res.meta,
		}
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

		const matches = this.search(normalized, true)
		if (!matches.length) return null

		if (matches.length === 1) {
			const info = this.getMemeInfo(matches[0])
			return info ? { kind: 'exact', info } : null
		}

		return { kind: 'choices', matches: matches.slice(0, 5) }
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

			this.pool = new Tinypool({
				filename: this.workerEntrypoint,
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
