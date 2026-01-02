import type { MemeImageResult } from '../types'
import { Buffer } from 'node:buffer'
import { deflateSync } from 'node:zlib'
import { spawn } from 'node:child_process'
import * as fsSync from 'node:fs'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

type CtxLike = {
	logger: { info: (...a: any[]) => void; warn: (...a: any[]) => void }
	honoService: { modifyApp: (fn: (app: any) => void) => void }
}

export type MemeListItem = {
	key: string
	minImages: number
	maxImages: number
	minTexts: number
	maxTexts: number
	tags: string[]
	keywords: string[]
}

type MemeWorkerLike = {
	ready: () => Promise<void>
	listKeys: () => string[]
	search: (query: string, includeTags?: boolean) => string[]
	getMemeInfo: (key: string) => any | null
	generateImage: (payload: any) => Promise<MemeImageResult>
}

export type MemeWorkerWebOptions = {
	basePath?: string
	aliasPaths?: string[]
}

export function registerMemeWorkerWeb(ctx: CtxLike, memeWorker: MemeWorkerLike, options?: MemeWorkerWebOptions) {
	const basePath = normalizeBasePath(options?.basePath ?? '/meme')
	const aliasPaths = (options?.aliasPaths ?? ['/meme-test']).map(normalizeBasePath).filter(Boolean)
	const mountPaths = [basePath, ...aliasPaths].filter((p, i, a) => a.indexOf(p) === i)

	let indexPromise: Promise<MemeListItem[]> | null = null
	const getIndex = () => {
		if (!indexPromise) {
			indexPromise = (async () => {
				await memeWorker.ready()
				return createMemeIndex(memeWorker)
			})()
		}
		return indexPromise
	}

	const previewInflight = new Map<string, Promise<MemeImageResult>>() // key: `preview:${key}`

	const renderCardSvg = (key: string): string => {
		const info = memeWorker.getMemeInfo(key)
		const params = info?.params
		const minImages = clampInt(params?.minImages ?? 0, 0, params?.maxImages ?? params?.minImages ?? 0)
		const maxImages = clampInt(params?.maxImages ?? minImages, minImages, 99)
		const minTexts = clampInt(params?.minTexts ?? 0, 0, params?.maxTexts ?? params?.minTexts ?? 0)
		const maxTexts = clampInt(params?.maxTexts ?? minTexts, minTexts, 99)

		return buildCardSvg({
			key,
			minImages,
			maxImages,
			minTexts,
			maxTexts,
		})
	}

	const placeholderPng16 = makeSolidPngWithBorder(16, 16, { r: 20, g: 28, b: 58, a: 255 }, { r: 90, g: 120, b: 255, a: 255 }, 1)

	const previewCacheDir = process.env.MEME_PREVIEW_CACHE_DIR?.trim()
		? process.env.MEME_PREVIEW_CACHE_DIR.trim()
		: path.join(process.cwd(), 'napi-rs-cache', 'meme-previews')

	const ensurePreviewCacheDir = async () => {
		await fs.mkdir(previewCacheDir, { recursive: true })
	}

	const previewCachePaths = (key: string) => {
		const safe = safeKeyForFilename(key)
		return {
			metaPath: path.join(previewCacheDir, `${safe}.json`),
			dataPath: path.join(previewCacheDir, `${safe}.bin`),
			failPath: path.join(previewCacheDir, `${safe}.fail.json`),
		}
	}

	let previewActive = 0
	const previewQueue: Array<() => void> = []
	const withPreviewLimit = async <T>(task: () => Promise<T>, concurrency = 1): Promise<T> => {
		if (previewActive >= concurrency) {
			await new Promise<void>((resolve) => previewQueue.push(resolve))
		}
		previewActive++
		try {
			return await task()
		} finally {
			previewActive--
			const next = previewQueue.shift()
			if (next) next()
		}
	}

	const renderPreview = async (key: string): Promise<MemeImageResult> => {
		const cacheKey = `preview:${key}`
		const hit = previewInflight.get(cacheKey)
		if (hit) return hit

		const p: Promise<MemeImageResult> = withPreviewLimit<MemeImageResult>(async () => {
			await ensurePreviewCacheDir().catch(() => {})
			const paths = previewCachePaths(key)

			// Use cached preview when available.
			const cached = await readPreviewCache(paths).catch(() => null)
			if (cached) return { ok: true, buffer: cached.buffer, mime: cached.mime, durationMs: 0, meta: { key } }

			// If it failed recently, avoid retrying (prevents repeated crashes).
			const fail = await readPreviewFail(paths).catch(() => null)
			if (fail && Date.now() - fail.at < 24 * 60 * 60_000) {
				return { ok: false, message: fail.message || 'preview failed', durationMs: 0 }
			}

			const info = memeWorker.getMemeInfo(key)
			const params = info?.params
			if (!params) return { ok: false, message: 'Unknown meme key', durationMs: 0 }

			const minImages = clampInt(params.minImages ?? 0, 0, params.maxImages ?? params.minImages ?? 0)
			const minTexts = clampInt(params.minTexts ?? 0, 0, params.maxTexts ?? params.minTexts ?? 0)
			const maxTexts = clampInt(params.maxTexts ?? minTexts, minTexts, 99)

			const memeGeneratorUrl = tryResolveMemeGeneratorUrl()
			if (!memeGeneratorUrl) {
				return { ok: false, message: 'meme generator unavailable (pluxel-plugin-napi-rs)', durationMs: 0 }
			}

			const res = await renderPreviewInSubprocess({
				key,
				placeholderPngBase64: placeholderPng16.toString('base64'),
				minImages,
				minTexts,
				maxTexts,
				memHome: process.env.MEME_HOME,
				memeGeneratorUrl,
				previewRunnerUrl: resolvePreviewRunnerUrl(),
			})

			if (!res.ok) {
				await writePreviewFail(paths, { at: Date.now(), message: res.message }).catch(() => {})
				return { ok: false, message: res.message, durationMs: res.durationMs }
			}

			// Cache only image outputs (web <img> friendly).
			if (res.mime?.startsWith('image/') && res.buffer?.length) {
				await writePreviewCache(paths, { mime: res.mime, buffer: res.buffer }).catch(() => {})
			}

			return res
		}).finally(() => {
			previewInflight.delete(cacheKey)
		})

		previewInflight.set(cacheKey, p)
		return p
	}

	const normalizeKey = (raw: unknown) => {
		const k = String(raw ?? '').trim()
		if (!k) return ''
		return k.replace(/\.png$/i, '').replace(/\.webp$/i, '')
	}

	const handleCardRequest = async (c: any, keyRaw: unknown) => {
		const key = normalizeKey(keyRaw)
		if (!key) return c.text('Missing key', 400)
		try {
			await memeWorker.ready()
		} catch {
			return c.text('Meme generator not ready', 503)
		}
		if (!memeWorker.getMemeInfo(key)) return c.text('Not found', 404)

		try {
			c.header('Cache-Control', 'public, max-age=3600')
			c.header('Content-Type', 'image/svg+xml; charset=utf-8')
			return c.body(renderCardSvg(key))
		} catch (e) {
			ctx.logger.warn(e, '[meme-worker] render card failed')
			return c.text('Not found', 404)
		}
	}

	const handlePreviewRequest = async (c: any, keyRaw: unknown) => {
		const key = normalizeKey(keyRaw)
		if (!key) return c.text('Missing key', 400)
		try {
			await memeWorker.ready()
		} catch (e) {
			ctx.logger.warn(e, '[meme-worker] preview warmup failed')
			return c.text('Meme generator not ready', 503)
		}
		if (!memeWorker.getMemeInfo(key)) return c.text('Not found', 404)

		try {
			const res = await renderPreview(key)
			if (!res.ok) throw new Error(res.message)

			// Ensure browser receives correct mime.
			c.header('Cache-Control', 'public, max-age=300')
			c.header('Content-Type', res.mime || 'application/octet-stream')
			return c.body(res.buffer)
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e)
			// Avoid log spam for common/expected errors.
			if (shouldWarnPreviewError(msg)) {
				ctx.logger.warn(e, '[meme-worker] render preview failed')
			}
			// Always fall back to a stable, dependency-free SVG card.
			return handleCardRequest(c, key)
		}
	}

	const mount = (prefix: string, app: any) => {
		app.get(prefix, (c: any) => c.redirect(`${prefix}/memes`))

		app.get(`${prefix}/api/memes`, async (c: any) => {
			const q = String(c.req.query('q') ?? '').trim().toLowerCase()
			let list: MemeListItem[]
			try {
				list = await getIndex()
			} catch {
				return c.json({ ok: false, message: 'Meme generator not ready' }, 503)
			}
			if (!q) return c.json({ ok: true, data: list })
			const filtered = list.filter((m) => {
				if (m.key.toLowerCase().includes(q)) return true
				if (m.tags.some((t) => t.toLowerCase().includes(q))) return true
				return (m.keywords ?? []).some((k) => String(k).toLowerCase().includes(q))
			})
			return c.json({ ok: true, data: filtered })
		})

		// Prefer query-based format so keys with dots still work.
		app.get(`${prefix}/card/:key`, async (c: any) => handleCardRequest(c, c.req.param('key')))
		// Back-compat.
		app.get(`${prefix}/card/:key.:ext`, async (c: any) => handleCardRequest(c, c.req.param('key')))

		app.get(`${prefix}/preview/:key`, async (c: any) => handlePreviewRequest(c, c.req.param('key')))
		app.get(`${prefix}/preview/:key.:ext`, async (c: any) => handlePreviewRequest(c, c.req.param('key')))

		app.get(`${prefix}/list`, async (c: any) => {
			const q = String(c.req.query('q') ?? '').trim()
			const rawPage = String(c.req.query('page') ?? '1')
			const rawPer = String(c.req.query('per') ?? '20')
			const page = Math.max(1, Number.parseInt(rawPage, 10) || 1)
			const per = Math.max(1, Math.min(200, Number.parseInt(rawPer, 10) || 20))
			const format = String(c.req.query('format') ?? '').trim().toLowerCase()

			try {
				await memeWorker.ready()
			} catch {
				return c.text('Meme generator not ready', 503)
			}

			const keys = q ? memeWorker.search(q, true) : memeWorker.listKeys()
			const total = keys.length
			const pages = Math.max(1, Math.ceil(total / per))
			const clampedPage = Math.min(page, pages)
			const start = (clampedPage - 1) * per
			const slice = keys.slice(start, start + per)

			const items = slice.map((key, i) => {
				const info = memeWorker.getMemeInfo(key)
				const p: any = info?.params ?? {}
				return {
					index: start + i + 1,
					key,
					minImages: Number(p.minImages ?? 0),
					maxImages: Number(p.maxImages ?? 0),
					minTexts: Number(p.minTexts ?? 0),
					maxTexts: Number(p.maxTexts ?? 0),
					keywords: Array.isArray((info as any)?.keywords) ? (info as any).keywords : [],
					tags: Array.isArray((info as any)?.tags) ? (info as any).tags : Array.from((info as any)?.tags ?? []),
				}
			})

			if (format === 'json') {
				return c.json({
					ok: true,
					data: {
						q: q || undefined,
						page: clampedPage,
						per,
						total,
						pages,
						items,
					},
				})
			}

			const lines: string[] = []
			lines.push(`Meme list${q ? ` (q=${q})` : ''}: page ${clampedPage}/${pages} • per ${per} • total ${total}`)
			lines.push(`Tip: ${prefix}/memes (web UI)`)
			lines.push('')
			for (const it of items) {
				const idx = String(it.index).padStart(4, '0')
				const req = `I${it.minImages}..${it.maxImages} T${it.minTexts}..${it.maxTexts}`
				const kw = it.keywords?.length ? ` kw:${it.keywords.slice(0, 3).join(',')}${it.keywords.length > 3 ? '…' : ''}` : ''
				const tg = it.tags?.length ? ` tag:${it.tags.slice(0, 3).join(',')}${it.tags.length > 3 ? '…' : ''}` : ''
				lines.push(`${idx} ${it.key} ${req}${kw}${tg}`)
			}

			c.header('Content-Type', 'text/plain; charset=utf-8')
			return c.text(lines.join('\n'))
		})

		// Back-compat (old image pages): redirect to text listing
		app.get(`${prefix}/list/:page`, (c: any) => {
			const raw = String(c.req.param('page') ?? '1')
			const page = Number(raw.replace(/\.(png|webp)$/i, '')) || 1
			return c.redirect(`${prefix}/list?page=${page}`)
		})
		app.get(`${prefix}/list/:page.:ext`, (c: any) => {
			const page = Number(String(c.req.param('page') ?? '1')) || 1
			return c.redirect(`${prefix}/list?page=${page}`)
		})

		app.get(`${prefix}/memes`, (c: any) => {
			const html = buildIndexHtml(prefix)
			c.header('Content-Type', 'text/html; charset=utf-8')
			return c.html(html)
		})
	}

	ctx.honoService.modifyApp((app) => {
		for (const p of mountPaths) mount(p, app)
	})

	ctx.logger.info(`[meme-worker] web routes mounted at ${mountPaths.map((p) => `${p}/memes`).join(', ')}`)
}

function createMemeIndex(memeWorker: MemeWorkerLike): MemeListItem[] {
	const keys = memeWorker.listKeys()
	const out: MemeListItem[] = []
	for (const key of keys) {
		const info = memeWorker.getMemeInfo(key)
		if (!info) continue
		const p: any = (info as any).params ?? {}
		out.push({
			key,
			minImages: Number(p.minImages ?? 0),
			maxImages: Number(p.maxImages ?? 0),
			minTexts: Number(p.minTexts ?? 0),
			maxTexts: Number(p.maxTexts ?? 0),
			tags: Array.isArray((info as any).tags) ? (info as any).tags : Array.from((info as any).tags ?? []),
			keywords: Array.isArray((info as any).keywords) ? (info as any).keywords : [],
		})
	}
	return out
}

function clampInt(value: unknown, min: number, max: number): number {
	const v = typeof value === 'number' ? value : Number(value)
	if (!Number.isFinite(v)) return min
	return Math.max(min, Math.min(max, Math.floor(v)))
}

function normalizeBasePath(value: string): string {
	const raw = String(value ?? '').trim()
	if (!raw) return ''
	const withSlash = raw.startsWith('/') ? raw : `/${raw}`
	const cleaned = withSlash.replace(/\/+$/, '')
	return cleaned || '/'
}

// (hashStrings removed: Takumi catalog images removed)

function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;')
}

function shortenKeyForCard(key: string, maxLen = 26): string {
	if (key.length <= maxLen) return key
	const head = Math.max(4, Math.floor((maxLen - 1) / 2))
	const tail = Math.max(4, maxLen - 1 - head)
	return `${key.slice(0, head)}…${key.slice(-tail)}`
}

function buildCardSvg(input: {
	key: string
	minImages: number
	maxImages: number
	minTexts: number
	maxTexts: number
}): string {
	const bg = '#0b1020'
	const fg = '#e7eaf3'
	const muted = '#9aa3b2'
	const border = '#222a3a'
	const img = '#4da3ff'
	const txt = '#7bd88f'

	const keyFull = String(input.key ?? '')
	const keyDisplay = shortenKeyForCard(keyFull)

	const imgRange = `${input.minImages}..${input.maxImages}`
	const txtRange = `${input.minTexts}..${input.maxTexts}`

	const keyEsc = escapeXml(keyDisplay)
	const keyFullEsc = escapeXml(keyFull)

	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" role="img" aria-label="${keyFullEsc}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#14204a" stop-opacity="0.40" />
      <stop offset="1" stop-color="#0b1020" stop-opacity="0.00" />
    </linearGradient>
  </defs>
  <rect x="0.5" y="0.5" width="511" height="511" rx="32" fill="${bg}" stroke="${border}" />
  <rect x="1" y="1" width="510" height="510" rx="31" fill="url(#g)" />
  <text x="32" y="78" fill="${fg}" font-size="44" font-weight="800" font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, &quot;Liberation Mono&quot;, &quot;Courier New&quot;, monospace">
    <title>${keyFullEsc}</title>${keyEsc}
  </text>
  <text x="32" y="112" fill="${muted}" font-size="16" font-family="Inter, &quot;Noto Sans SC&quot;, &quot;PingFang SC&quot;, &quot;Microsoft YaHei&quot;, system-ui, sans-serif">Meme requirements</text>
  <g transform="translate(32,140)">
    <rect x="0.5" y="0.5" width="210" height="44" rx="16" fill="${img}" fill-opacity="0.12" stroke="${border}" />
    <text x="16" y="29" fill="${img}" font-size="18" font-weight="800" font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, &quot;Liberation Mono&quot;, &quot;Courier New&quot;, monospace">I</text>
    <text x="40" y="29" fill="${img}" font-size="18" font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, &quot;Liberation Mono&quot;, &quot;Courier New&quot;, monospace">${escapeXml(imgRange)}</text>
    <rect x="226.5" y="0.5" width="210" height="44" rx="16" fill="${txt}" fill-opacity="0.12" stroke="${border}" />
    <text x="242" y="29" fill="${txt}" font-size="18" font-weight="800" font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, &quot;Liberation Mono&quot;, &quot;Courier New&quot;, monospace">T</text>
    <text x="266" y="29" fill="${txt}" font-size="18" font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, &quot;Liberation Mono&quot;, &quot;Courier New&quot;, monospace">${escapeXml(txtRange)}</text>
  </g>
  <text x="32" y="472" fill="${muted}" font-size="14" font-family="Inter, &quot;Noto Sans SC&quot;, &quot;PingFang SC&quot;, &quot;Microsoft YaHei&quot;, system-ui, sans-serif">Preview unavailable</text>
</svg>`
}

type Rgba = { r: number; g: number; b: number; a: number }

function makeSolidPngWithBorder(width: number, height: number, fill: Rgba, border: Rgba, borderSize: number): Buffer {
	const w = Math.max(1, Math.floor(width))
	const h = Math.max(1, Math.floor(height))
	const bs = Math.max(0, Math.min(Math.floor(borderSize), Math.floor(Math.min(w, h) / 2)))
	const rowBytes = w * 4 + 1
	const raw = Buffer.alloc(rowBytes * h)
	for (let y = 0; y < h; y++) {
		const rowStart = y * rowBytes
		raw[rowStart] = 0 // filter type: none
		for (let x = 0; x < w; x++) {
			const p = rowStart + 1 + x * 4
			const isBorder = bs > 0 && (x < bs || y < bs || x >= w - bs || y >= h - bs)
			const c = isBorder ? border : fill
			raw[p + 0] = c.r & 0xff
			raw[p + 1] = c.g & 0xff
			raw[p + 2] = c.b & 0xff
			raw[p + 3] = c.a & 0xff
		}
	}

	const ihdr = Buffer.alloc(13)
	ihdr.writeUInt32BE(w, 0)
	ihdr.writeUInt32BE(h, 4)
	ihdr[8] = 8 // bit depth
	ihdr[9] = 6 // color type RGBA
	ihdr[10] = 0 // compression
	ihdr[11] = 0 // filter
	ihdr[12] = 0 // interlace

	const idat = deflateSync(raw)
	const chunks = [
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk('IHDR', ihdr),
		pngChunk('IDAT', idat),
		pngChunk('IEND', Buffer.alloc(0)),
	]
	return Buffer.concat(chunks)
}

function pngChunk(type: string, data: Buffer): Buffer {
	const t = Buffer.from(type, 'ascii')
	const len = Buffer.alloc(4)
	len.writeUInt32BE(data.length, 0)
	const crcBuf = Buffer.concat([t, data])
	const crc = Buffer.alloc(4)
	crc.writeUInt32BE(crc32(crcBuf), 0)
	return Buffer.concat([len, t, data, crc])
}

let _crcTable: Uint32Array | null = null
function crc32(buf: Buffer): number {
	if (!_crcTable) {
		const table = new Uint32Array(256)
		for (let i = 0; i < 256; i++) {
			let c = i
			for (let k = 0; k < 8; k++) {
				c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
			}
			table[i] = c >>> 0
		}
		_crcTable = table
	}

	let crc = 0xffffffff
	for (let i = 0; i < buf.length; i++) {
		crc = (_crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)) >>> 0
	}
	return (crc ^ 0xffffffff) >>> 0
}

function safeKeyForFilename(key: string): string {
	// Stable + filesystem-safe.
	// base64url preserves uniqueness while keeping filenames short.
	return Buffer.from(key).toString('base64url')
}

async function readPreviewCache(paths: { metaPath: string; dataPath: string }): Promise<{ mime: string; buffer: Buffer } | null> {
	const metaRaw = await fs.readFile(paths.metaPath, 'utf8').catch(() => null)
	if (!metaRaw) return null
	const meta = JSON.parse(metaRaw) as { mime?: unknown }
	if (typeof meta.mime !== 'string' || !meta.mime) return null
	const buf = await fs.readFile(paths.dataPath).catch(() => null)
	if (!buf) return null
	return { mime: meta.mime, buffer: buf }
}

async function writePreviewCache(paths: { metaPath: string; dataPath: string }, data: { mime: string; buffer: Buffer }): Promise<void> {
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'meme-preview-cache-'))
	const metaTmp = path.join(tmp, 'meta.json')
	const dataTmp = path.join(tmp, 'data.bin')
	try {
		await fs.writeFile(metaTmp, JSON.stringify({ mime: data.mime }))
		await fs.writeFile(dataTmp, data.buffer)
		await fs.rename(metaTmp, paths.metaPath).catch(async () => {
			await fs.copyFile(metaTmp, paths.metaPath)
			await fs.unlink(metaTmp).catch(() => {})
		})
		await fs.rename(dataTmp, paths.dataPath).catch(async () => {
			await fs.copyFile(dataTmp, paths.dataPath)
			await fs.unlink(dataTmp).catch(() => {})
		})
	} finally {
		await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
	}
}

async function readPreviewFail(paths: { failPath: string }): Promise<{ at: number; message: string } | null> {
	const raw = await fs.readFile(paths.failPath, 'utf8').catch(() => null)
	if (!raw) return null
	const v = JSON.parse(raw) as { at?: unknown; message?: unknown }
	const at = typeof v.at === 'number' ? v.at : 0
	const message = typeof v.message === 'string' ? v.message : ''
	if (!at || !message) return null
	return { at, message }
}

async function writePreviewFail(paths: { failPath: string }, data: { at: number; message: string }): Promise<void> {
	await fs.writeFile(paths.failPath, JSON.stringify(data)).catch(() => {})
}

async function renderPreviewInSubprocess(input: {
	key: string
	placeholderPngBase64: string
	minImages: number
	minTexts: number
	maxTexts: number
	memHome?: string
	memeGeneratorUrl: string
	previewRunnerUrl: string
}): Promise<MemeImageResult> {
	const started = Date.now()

	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meme-preview-run-'))
	const outPath = path.join(tmpDir, 'out.bin')
	try {
			const child = spawn(
				process.execPath,
				[
					// Run the dedicated runner file to keep the parent code small and debuggable.
				input.previewRunnerUrl,
				input.key,
				String(input.minImages),
				String(input.minTexts),
					String(input.maxTexts),
				],
				{
					stdio: ['ignore', 'pipe', 'pipe'],
					env: {
						...process.env,
						OUT_PATH: outPath,
						PLACEHOLDER_B64: input.placeholderPngBase64,
						MEME_GENERATOR_URL: input.memeGeneratorUrl,
						MEME_HOME: input.memHome ?? process.env.MEME_HOME ?? '',
					},
				},
			)

		let out = ''
		let errOut = ''
		child.stdout.on('data', (d) => {
			out += String(d)
		})
		child.stderr.on('data', (d) => {
			errOut += String(d)
		})

		const exitCode: number = await new Promise((resolve) => {
			child.on('close', (code) => resolve(code ?? 0))
			child.on('error', () => resolve(-1))
		})

		const lastLine = out.trim().split(/\r?\n/).pop() || ''
		let meta: any = null
		try {
			meta = lastLine ? JSON.parse(lastLine) : null
		} catch {
			meta = null
		}

		if (!meta?.ok || exitCode !== 0) {
			const msg =
				typeof meta?.message === 'string' && meta.message
					? meta.message
					: errOut.trim().slice(0, 240) || `preview subprocess failed (code=${exitCode})`
			return { ok: false, message: msg, durationMs: Date.now() - started }
		}

		const buf = await fs.readFile(outPath)
		const mime = typeof meta.mime === 'string' ? meta.mime : 'application/octet-stream'
		return { ok: true, buffer: buf, mime, durationMs: Date.now() - started, meta: { key: input.key } }
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
	}
}

let _memeGeneratorUrlResolved: string | null | undefined = undefined
function tryResolveMemeGeneratorUrl(): string | null {
	if (_memeGeneratorUrlResolved !== undefined) return _memeGeneratorUrlResolved
	try {
		const require = createRequire(import.meta.url)
		const resolvedPath = require.resolve('pluxel-plugin-napi-rs/meme-generator')
		_memeGeneratorUrlResolved = pathToFileURL(resolvedPath).href
	} catch {
		_memeGeneratorUrlResolved = null
	}
	return _memeGeneratorUrlResolved
}

let _previewRunnerPath: string | null = null
function resolvePreviewRunnerUrl(): string {
	if (_previewRunnerPath) return _previewRunnerPath

	const currentDir = path.dirname(fileURLToPath(import.meta.url))
	const candidates = [
		// dev: src/web -> src/preview-runner.mjs
		path.join(currentDir, '..', 'preview-runner.mjs'),
		// build: dist -> dist/preview-runner.mjs (when bundled, currentDir is dist)
		path.join(currentDir, 'preview-runner.mjs'),
		// dev: src/web -> dist/preview-runner.mjs
		path.join(currentDir, '..', '..', 'dist', 'preview-runner.mjs'),
	]

	for (const p of candidates) {
		if (fsSync.existsSync(p)) {
			_previewRunnerPath = p
			return _previewRunnerPath
		}
	}

	// Fallback: try resolving from package root (installed case).
	try {
		const require = createRequire(import.meta.url)
		const root = path.dirname(require.resolve('pluxel-plugin-meme-worker/package.json'))
		const dist = path.join(root, 'dist', 'preview-runner.mjs')
		if (fsSync.existsSync(dist)) {
			_previewRunnerPath = dist
			return dist
		}
	} catch {}

	throw new Error('preview runner not found')
}

function shouldWarnPreviewError(msg: string): boolean {
	if (!msg) return true
	if (msg === 'Unknown meme key') return false
	if (msg.startsWith('未找到模板：')) return false
	if (msg.startsWith('该模板需要 ')) return false
	if (msg.startsWith('该模板允许 ')) return false
	if (msg.startsWith('存在超长文本：')) return false
	if (msg.startsWith('缺少资源：')) return false
	if (msg.includes('pluxel-plugin-napi-rs') && msg.includes('unavailable')) return false
	if (msg.includes('Cannot find package') && msg.includes('pluxel-plugin-napi-rs')) return false
	if (msg.includes('Cannot find module') && msg.includes('pluxel-plugin-napi-rs')) return false
	return true
}

function buildIndexHtml(basePath: string): string {
	// lightweight client-side filter for highest density (no heavy framework).
	return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Meme List</title>
  <style>
    :root { color-scheme: dark; --bg:#0b1020; --fg:#e7eaf3; --muted:#9aa3b2; --border:#222a3a; --img:#4da3ff; --txt:#7bd88f; }
    html,body{height:100%;margin:0;background:var(--bg);color:var(--fg);font-family:Inter,"Noto Sans SC","PingFang SC","Microsoft YaHei",system-ui,sans-serif;}
    a{color:var(--fg)}
    header{position:fixed;top:0;left:0;right:0;background:rgba(11,16,32,0.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--border);z-index:100}
    body{padding-top:calc(var(--header-h, 160px) + 8px)}
    .wrap{max-width:1200px;margin:0 auto;padding:16px}
    .title{display:flex;gap:12px;align-items:baseline;justify-content:space-between}
    h1{font-size:22px;margin:0}
    .legend{font-size:12px;color:var(--muted);display:flex;gap:14px;align-items:center;flex-wrap:wrap}
    .badge{display:inline-flex;gap:6px;align-items:center;border:1px solid var(--border);border-radius:999px;padding:4px 10px}
    .I{color:var(--img);font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;font-weight:800}
    .T{color:var(--txt);font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;font-weight:800}
    .KW{color:#ffb84d;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;font-weight:800}
    .TAG{color:#b68cff;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;font-weight:800}
    .controls{display:flex;gap:10px;align-items:center;margin-top:10px}
    input{flex:1;min-width:240px;background:#0f1730;border:1px solid var(--border);color:var(--fg);border-radius:10px;padding:10px 12px;font-size:14px}
    .meta{font-size:12px;color:var(--muted)}
    .grid{margin-top:14px;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px}
    .item{border:1px solid var(--border);border-radius:12px;padding:10px 12px;background:rgba(255,255,255,0.02)}
    .row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center}
    .thumb{width:100%;aspect-ratio:1/1;border-radius:12px;object-fit:cover;border:1px solid var(--border);background:#0f1730;margin-top:10px}
    .thumb.loading{background:linear-gradient(90deg,#0f1730,#14204a,#0f1730);background-size:200% 100%;animation:shimmer 1.1s ease-in-out infinite}
    @keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
    .key{min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;background:transparent;border:0;color:var(--fg);padding:0;cursor:pointer;text-align:left}
    .key:hover{text-decoration:underline}
    .req{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
    button{background:#111a33;border:1px solid var(--border);color:var(--fg);border-radius:10px;padding:7px 10px;font-size:12px;cursor:pointer}
    button:hover{background:#152042}
    .small{font-size:11px;color:var(--muted);margin-top:8px;display:flex;justify-content:flex-start;gap:10px}
    .chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
    .chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border);border-radius:999px;padding:3px 8px;background:rgba(255,255,255,0.02);cursor:pointer;user-select:none}
    .chip:hover{background:rgba(255,255,255,0.05)}
    .chip .k{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;color:var(--fg)}
    .chip.kw .k{color:#ffb84d}
    .chip.tag .k{color:#b68cff}
  </style>
</head>
<body>
  <header>
    <div class="wrap">
      <div class="title">
        <h1>Meme List</h1>
        <div class="meta"><span id="count">…</span></div>
      </div>
      <div class="legend">
        <span class="badge"><span class="I">I</span> images(min..max)</span>
        <span class="badge"><span class="T">T</span> texts(min..max)</span>
        <span class="badge"><span class="KW">KW</span> keyword</span>
        <span class="badge"><span class="TAG">TAG</span> tag</span>
        <span class="badge">Click key to copy</span>
        <span class="badge">Click chip to copy</span>
        <span class="badge">Click image to open</span>
      </div>
      <div class="controls">
        <input id="q" placeholder="Search key or tag… (e.g. 5000 / dog / 动物)" autocomplete="off" />
        <button id="clear">Clear</button>
      </div>
    </div>
  </header>
  <main class="wrap">
    <div id="grid" class="grid"></div>
  </main>
<script>
window.__io = null;
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
const $q = document.getElementById('q');
const $grid = document.getElementById('grid');
const $count = document.getElementById('count');
const $clear = document.getElementById('clear');
let all = [];

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function setupStickyHeader() {
  const header = document.querySelector('header');
  if (!header) return;
  const update = () => {
    document.documentElement.style.setProperty('--header-h', header.offsetHeight + 'px');
  };
  update();
  if ('ResizeObserver' in window) {
    try { new ResizeObserver(update).observe(header); } catch {}
  }
  window.addEventListener('resize', update);
}

async function copyText(text, node) {
  try {
    await navigator.clipboard.writeText(text);
    if (node) {
      const old = node.textContent;
      node.textContent = 'Copied';
      setTimeout(() => { node.textContent = old; }, 650);
    }
  } catch {}
}

function chip(kind, text) {
  const c = el('span', 'chip ' + kind);
  const k = el('span', 'k', text);
  c.appendChild(k);
  c.title = 'Click to copy';
  c.onclick = () => copyText(text, k);
  return c;
}

function render(list) {
  $grid.innerHTML = '';
  $count.textContent = list.length + ' items';
  if (window.__io) window.__io.disconnect();
  const io = ('IntersectionObserver' in window) ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const img = e.target;
      const p = img.dataset && img.dataset.preview;
      if (!p) continue;
      if (img.dataset.loaded) continue;
      img.dataset.loaded = '1';
      img.dataset.state = 'preview';
      img.src = p;
    }
  }, { rootMargin: '400px 0px' }) : null;
  window.__io = io;
  for (const m of list) {
    const card = el('div', 'item');
    const aimg = document.createElement('a');
    aimg.href = '${basePath}/preview/' + encodeURIComponent(m.key);
    aimg.target = '_blank';
    aimg.rel = 'noreferrer';
    const img = document.createElement('img');
    img.className = 'thumb loading';
    img.loading = 'lazy';
    img.alt = m.key;
    img.dataset.state = 'blank';
    img.src = BLANK;
    img.dataset.card = '${basePath}/card/' + encodeURIComponent(m.key);
    img.dataset.preview = '${basePath}/preview/' + encodeURIComponent(m.key);
    img.onload = () => {
      if (img.dataset.state === 'blank') return;
      img.classList.remove('loading');
    };
    img.onerror = () => {
      img.onerror = null;
      img.dataset.state = 'card';
      img.classList.remove('loading');
      img.src = img.dataset.card || BLANK;
    };
    aimg.appendChild(img);
    const row = el('div', 'row');
    const key = el('button', 'key', m.key);
    key.title = m.key;
    key.type = 'button';
    key.onclick = () => copyText(m.key, key);
    row.appendChild(key);
    const req = el('div', 'req');
    const i = el('span', 'badge'); i.innerHTML = '<span class="I">I</span> ' + m.minImages + '..' + m.maxImages;
    const t = el('span', 'badge'); t.innerHTML = '<span class="T">T</span> ' + m.minTexts + '..' + m.maxTexts;
    req.appendChild(i); req.appendChild(t);
    row.appendChild(req);
    card.appendChild(row);
    card.appendChild(aimg);
    const small = el('div', 'small');
    const chips = el('div', 'chips');
    for (const kw of (m.keywords || [])) chips.appendChild(chip('kw', kw));
    for (const tg of (m.tags || [])) chips.appendChild(chip('tag', tg));
    small.appendChild(chips);
    card.appendChild(small);
    $grid.appendChild(card);
    if (io) io.observe(img);
    else { img.dataset.state = 'preview'; img.src = img.dataset.preview; }
  }
}

async function load() {
  const res = await fetch('${basePath}/api/memes');
  const json = await res.json();
  all = (json && json.data) || [];
  render(all);
}

function apply() {
  const q = ($q.value || '').trim().toLowerCase();
  if (!q) return render(all);
  const out = all.filter(m =>
    (m.key||'').toLowerCase().includes(q) ||
    (m.tags||[]).some(t => (t||'').toLowerCase().includes(q)) ||
    (m.keywords||[]).some(k => (k||'').toLowerCase().includes(q))
  );
  render(out);
}

let timer = null;
$q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(apply, 80); });
$clear.onclick = () => { $q.value=''; apply(); };
setupStickyHeader();
load().catch(err => { $count.textContent = 'load failed'; console.error(err); });
</script>
</body>
</html>`
}
