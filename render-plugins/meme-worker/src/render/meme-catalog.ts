import { Buffer } from 'node:buffer'

type CtxLike = { logger: { warn: (...a: any[]) => void } }
type MemeWorkerLike = { listKeys: () => string[]; getMemeInfo: (key: string) => any | null }

export type MemeCatalogRenderOptions = {
	maxItemsPerImage: number
	width: number
	devicePixelRatio: number
	maxPixelHeight?: number
	format: 'png' | 'webp'
}

export type MemeCatalogRenderResult = {
	format: 'png' | 'webp'
	total: number
	buffers: Buffer[]
}

type Item = {
	key: string
	minImages: number
	maxImages: number
	minTexts: number
	maxTexts: number
}

export async function renderMemeCatalogImages(
	ctx: CtxLike,
	memeWorker: MemeWorkerLike,
	opts: MemeCatalogRenderOptions,
): Promise<MemeCatalogRenderResult> {
	const keys = memeWorker.listKeys()
	const items = keys
		.map((key) => {
			const info = memeWorker.getMemeInfo(key)
			const p = info?.params
			if (!p) return null
			return {
				key,
				minImages: p.minImages,
				maxImages: p.maxImages,
				minTexts: p.minTexts,
				maxTexts: p.maxTexts,
			} satisfies Item
		})
		.filter(Boolean) as Item[]

	if (items.length === 0) return { format: opts.format, total: 0, buffers: [] }

	const renderer = await loadTakumiRenderer(ctx)

	const maxPixelHeight = opts.maxPixelHeight ?? 24_000
	const format = opts.format

	const buffers: Buffer[] = []
	const pageCounts: number[] = []
	let start = 0
	while (start < items.length) {
		const maxCount = Math.min(items.length - start, Math.max(1, opts.maxItemsPerImage))

		// For non-PNG formats, we can't reliably read dimensions here; just use maxCount.
		if (format !== 'png') {
			const slice = items.slice(start, start + maxCount)
			const node = buildCatalogNode(slice, {
				width: opts.width,
				totalItems: items.length,
				pageIndex: buffers.length,
				startIndex: start,
			})
			const buf = await renderer.render(node, {
				format,
				width: opts.width,
				devicePixelRatio: opts.devicePixelRatio,
				// IMPORTANT: omit height to let Takumi compute intrinsic height.
			})
			buffers.push(buf)
			pageCounts.push(slice.length)
			start += slice.length
			continue
		}

		// PNG: enforce height limit by choosing largest count that fits.
		let lo = 1
		let hi = maxCount
		let best: { buffer: Buffer; count: number } | null = null

		while (lo <= hi) {
			const mid = Math.floor((lo + hi) / 2)
			const slice = items.slice(start, start + mid)
			const node = buildCatalogNode(slice, {
				width: opts.width,
				totalItems: items.length,
				pageIndex: buffers.length,
				startIndex: start,
			})

			const buf = await renderer.render(node, {
				format,
				width: opts.width,
				devicePixelRatio: opts.devicePixelRatio,
			})

			const size = readPngSize(buf)
			const heightPx = size?.height ?? -1
			if (heightPx > 0 && heightPx <= maxPixelHeight) {
				best = { buffer: buf, count: mid }
				lo = mid + 1
			} else {
				hi = mid - 1
			}
		}

		if (!best) {
			// Even 1 item exceeds limit (or size parse failed); accept 1 to make progress.
			const slice = items.slice(start, start + 1)
			const node = buildCatalogNode(slice, {
				width: opts.width,
				totalItems: items.length,
				pageIndex: buffers.length,
				startIndex: start,
			})
			const buf = await renderer.render(node, {
				format,
				width: opts.width,
				devicePixelRatio: opts.devicePixelRatio,
			})
			best = { buffer: buf, count: 1 }
		}

		buffers.push(best.buffer)
		start += best.count
		pageCounts.push(best.count)
	}

	return { format, total: items.length, buffers }
}

async function loadTakumiRenderer(ctx: CtxLike): Promise<{ render: (node: unknown, opts: any) => Promise<Buffer> }> {
	const mod: any = await import('pluxel-plugin-napi-rs/core')
	const Renderer = mod?.Renderer ?? mod?.default?.Renderer
	if (typeof Renderer !== 'function') {
		ctx.logger.warn({ keys: Object.keys(mod ?? {}) }, '[meme-worker] takumi Renderer unavailable')
		throw new Error('Renderer unavailable')
	}
	return new Renderer({ loadDefaultFonts: true })
}

function buildCatalogNode(
	items: Item[],
	meta: { width: number; totalItems: number; pageIndex: number; startIndex: number },
): unknown {
	const bg = '#0b1020'
	const fg = '#e7eaf3'
	const muted = '#9aa3b2'
	const imgColor = '#4da3ff'
	const txtColor = '#7bd88f'
	const border = '#222a3a'
	const fontSans = 'Inter, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
	const fontMono =
		'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'

	const padding = 18
	// Extra safety gutter to avoid rare right-edge clipping from font metrics / rounding.
	// Also makes the layout more robust if the renderer treats `width` as content-box.
	const safeGutter = 56
	const paddingLeft = padding
	const paddingRight = padding + safeGutter
	const contentWidth = Math.max(1, meta.width - paddingLeft - paddingRight)
	const wrapGap = 6

	const pageText = `page ${meta.pageIndex + 1} • total ${meta.totalItems}`

	const pills = items.map((it, idx) => {
		const absoluteIndex = meta.startIndex + idx + 1
		// Key affects packing: compute a per-item width, but clamp to contentWidth to avoid overflow.
		// Keep flexShrink=0 on the pill itself (Takumi can otherwise collapse pills to near-zero width).
		const keyLen = Math.min(36, Math.max(4, it.key.length))
		const pillMinOuter = 200
		const pillMaxOuter = Math.min(560, contentWidth)
		const pillOuter = clamp(210 + keyLen * 9, pillMinOuter, pillMaxOuter)
		// Be conservative about what `width` means (content-box vs border-box).
		// If `width` is treated as content-box, padding+border will add extra pixels and can overflow.
		const pillExtraX = 6 + 6 + 1 + 1
		const pillWidth = Math.max(1, pillOuter - pillExtraX)
		return {
			type: 'container',
			style: {
				display: 'flex',
				flexDirection: 'row',
				alignItems: 'center',
				gap: 2,
				paddingLeft: 6,
				paddingRight: 6,
				paddingTop: 3,
				paddingBottom: 3,
				borderWidth: 1,
				borderColor: border,
				borderRadius: 10,
				backgroundColor: 'rgba(255,255,255,0.02)',
				width: pillWidth,
				maxWidth: pillWidth,
				minWidth: pillWidth,
				// IMPORTANT: prevent Takumi flexbox from shrinking pills to fit more in a row,
				// which can collapse intermediate pills and look like “missing indices”.
				// Wrapping is preferred over shrinking for correctness/readability.
				flexShrink: 0,
				flexGrow: 0,
				overflow: 'hidden',
			},
			children: [
				{
					type: 'text',
					text: String(absoluteIndex).padStart(3, '0'),
					style: {
						fontSize: 10,
						color: muted,
						fontFamily: fontMono,
						flexShrink: 0,
					},
				},
				{
					type: 'container',
					style: {
						minWidth: 0,
						flexShrink: 1,
						flexGrow: 1,
						flexBasis: 0,
						overflow: 'hidden',
					},
					children: [
						{
							type: 'text',
							text: it.key,
							style: {
								fontSize: 11,
								color: fg,
								fontFamily: fontMono,
								whiteSpace: 'nowrap',
								textWrap: 'nowrap',
								textOverflow: 'ellipsis',
								lineClamp: 1,
								overflow: 'hidden',
								flexShrink: 1,
							},
						},
					],
				},
				{
					type: 'text',
					text: `I${it.minImages}..${it.maxImages}`,
					style: { fontSize: 10, color: imgColor, fontFamily: fontMono, flexShrink: 0 },
				},
				{
					type: 'text',
					text: `T${it.minTexts}..${it.maxTexts}`,
					style: { fontSize: 10, color: txtColor, fontFamily: fontMono, flexShrink: 0 },
				},
			],
		}
	})

	return {
		type: 'container',
		style: {
			width: meta.width,
			backgroundColor: bg,
			borderRadius: 18,
			display: 'flex',
			flexDirection: 'column',
			fontFamily: fontSans,
			alignItems: 'stretch',
			overflow: 'hidden',
		},
		children: [
			{
				type: 'container',
				style: {
					borderWidth: 1,
					borderColor: border,
					borderRadius: 18,
					paddingLeft,
					paddingRight,
					paddingTop: padding,
					paddingBottom: padding,
					display: 'flex',
					flexDirection: 'column',
					gap: 10,
					backgroundColor: bg,
					alignItems: 'stretch',
				},
				children: [
					{
						type: 'container',
						style: {
							display: 'flex',
							flexDirection: 'row',
							alignItems: 'baseline',
							justifyContent: 'space-between',
						},
						children: [
							{
								type: 'text',
								text: 'Meme Catalog (zoom to read)',
								style: { fontSize: 28, fontWeight: 800, color: fg, fontFamily: fontSans },
							},
							{
								type: 'text',
								text: pageText,
								style: { fontSize: 13, color: muted, fontFamily: fontSans },
							},
						],
					},
					{
						type: 'text',
						text: 'I=images(min..max)  T=texts(min..max)  open: /meme/memes',
						style: { fontSize: 12, color: muted, fontFamily: fontMono },
					},
					{
						type: 'container',
						style: {
							display: 'flex',
							flexDirection: 'row',
							flexWrap: 'wrap',
							gap: wrapGap,
							alignItems: 'center',
							alignContent: 'flex-start',
							overflow: 'hidden',
						},
						children: pills,
					},
				],
			},
		],
	}
}

function clamp(n: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, n))
}

function readPngSize(buf: Buffer): { width: number; height: number } | null {
	if (buf.length < 24) return null
	// PNG signature
	if (
		buf[0] !== 0x89 ||
		buf[1] !== 0x50 ||
		buf[2] !== 0x4e ||
		buf[3] !== 0x47 ||
		buf[4] !== 0x0d ||
		buf[5] !== 0x0a ||
		buf[6] !== 0x1a ||
		buf[7] !== 0x0a
	) {
		return null
	}
	// IHDR chunk should start at byte 8+4(length)+4(type)=16; width/height at 16..23
	if (buf.toString('ascii', 12, 16) !== 'IHDR') return null
	const width = buf.readUInt32BE(16)
	const height = buf.readUInt32BE(20)
	if (!Number.isFinite(width) || !Number.isFinite(height)) return null
	if (width <= 0 || height <= 0) return null
	return { width, height }
}
