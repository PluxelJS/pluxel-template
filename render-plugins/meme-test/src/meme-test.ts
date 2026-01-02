import { Buffer } from 'node:buffer'

import { BasePlugin, Plugin } from '@pluxel/hmr'
import 'pluxel-plugin-napi-rs'
import {
	resolveAttachments,
	resolveAuthorAvatarImage,
	resolveUserAvatarImage,
	type AvatarTraceEvent,
	type MessageContent,
	type MentionPart,
	type Part,
	type ResolvedAttachment,
} from '@pluxel/bot-layer'
import { Chatbots, type ChatbotsCommandContext } from 'pluxel-plugin-chatbots'
import { MemeWorker, type MemeMetadata } from 'pluxel-plugin-meme-worker'

const LIST_PER_PAGE = 20

type MemeImage = { name: string; data: Buffer }

@Plugin({ name: 'MemeTest', type: 'service' })
export class MemeTest extends BasePlugin {
	constructor(
		private readonly chatbots: Chatbots,
		private readonly memeWorker: MemeWorker,
	) {
		super()
	}

	override init(): void {
		this.registerCommands()
		this.ctx.logger.info('[meme-test] ready')
	}

	private registerCommands() {
		const permission = this.chatbots.permission
		permission.declareStar('cmd.meme', { default: 'allow', description: 'Meme commands' })
		const permList = permission.declareExact('cmd.meme.list', {
			default: 'allow',
			description: 'List meme keys',
		})
		const permInfo = permission.declareExact('cmd.meme.info', {
			default: 'allow',
			description: 'Show meme metadata',
		})
		const permMake = permission.declareExact('cmd.meme.make', {
			default: 'allow',
			description: 'Render meme image',
		})

		this.chatbots.cmd.group('meme', (cmd) => {
			cmd
				.reg('meme list [query]')
				.describe('List memes or search by keyword')
				.perm(permList)
				.action(({ query }) => this.listMemes(query))
			// Convenience aliases (so `meme list.img` works without a space)
			cmd
				.reg('meme list.img')
				.describe('Render meme list image')
				.perm(permList)
				.action(() => this.listMemes('img'))
			cmd
				.reg('meme list.image')
				.describe('Render meme list image')
				.perm(permList)
				.action(() => this.listMemes('img'))

				cmd
					.reg('meme info <key>')
					.describe('Show meme metadata')
					.perm(permInfo)
					.action(({ key }) => this.showInfo(key))

			cmd
				.reg('meme make <key> [...text]')
				.describe('Render a meme (default: avatars, then attachments)')
				.perm(permMake)
				.action(({ key, text }, ctx) => this.renderMeme(key, text, ctx))
		})
	}

	private async listMemes(query?: string): Promise<MessageContent> {
		try {
			await this.memeWorker.ready()
		} catch (e) {
			return `Meme generator not ready (${e instanceof Error ? e.message : String(e)})`
		}

		const raw = String(query ?? '').trim()
		const wantsImageList =
			raw === 'img' || raw === 'image' || raw === 'list.img' || raw === 'list.image' || raw.endsWith('.img') || raw.endsWith('.image')

		const raw2 = wantsImageList ? raw.replace(/^list\./i, '').replace(/\.(img|image)$/i, '').trim() : raw
		const isPageOnly = /^\d+$/.test(raw2)
		const page = Math.max(1, isPageOnly ? Number(raw2) : 1)
		const q = wantsImageList ? '' : raw2

		if (wantsImageList) {
			const res = await this.memeWorker.getMemeListImage({ sortBy: 'Key' })
			if (!res.ok) return res.message
			const ext =
				res.mime === 'image/webp'
					? 'webp'
					: res.mime === 'image/jpeg'
						? 'jpg'
						: 'png'
			return {
				type: 'image',
				data: res.buffer,
				mime: res.mime,
				name: `meme-list.${ext}`,
			}
		}

		const keys = q ? this.memeWorker.search(q, true) : this.memeWorker.listKeys()
		if (keys.length === 0) return q ? `No memes match "${q}".` : 'No memes available.'

		const total = keys.length
		const pages = Math.max(1, Math.ceil(total / LIST_PER_PAGE))
		const p = Math.min(page, pages)
		const start = (p - 1) * LIST_PER_PAGE
		const slice = keys.slice(start, start + LIST_PER_PAGE)

		const lines: string[] = []
		lines.push(`Meme list${q ? ` (q=${q})` : ''}: page ${p}/${pages} • per ${LIST_PER_PAGE} • total ${total}`)
		lines.push('Legend: I=min..max images, T=min..max texts, KW=keywords, TAG=tags')
		lines.push('Tip: open /meme/memes for search + preview images')
		lines.push('')
		for (let i = 0; i < slice.length; i++) {
			const key = slice[i]
			const info = this.memeWorker.getMemeInfo(key)
			const params = info?.params
			const idx = String(start + i + 1).padStart(4, '0')
			const req = params ? `I${params.minImages}..${params.maxImages} T${params.minTexts}..${params.maxTexts}` : 'I? T?'
			const kw = (info as any)?.keywords
			const tags = (info as any)?.tags
			const kwText =
				Array.isArray(kw) && kw.length ? ` KW:${kw.slice(0, 3).join(',')}${kw.length > 3 ? '…' : ''}` : ''
			const tagArr = Array.isArray(tags) ? tags : Array.from(tags ?? [])
			const tagText =
				Array.isArray(tagArr) && tagArr.length
					? ` TAG:${tagArr.slice(0, 3).join(',')}${tagArr.length > 3 ? '…' : ''}`
					: ''
			lines.push(`${idx} ${key} ${req}${kwText}${tagText}`)
		}

		if (pages > 1) {
			lines.push('')
			lines.push(`Next: meme list ${Math.min(p + 1, pages)}`)
			lines.push(`Image: meme list.img`)
		}
		return lines.join('\n')
	}

	private async showInfo(key: string): Promise<MessageContent> {
		try {
			await this.memeWorker.ready()
		} catch (e) {
			return `Meme generator not ready (${e instanceof Error ? e.message : String(e)})`
		}
		const info = this.resolveMemeInfo(key)
		if (!info.ok) return info.message
		return this.buildJsonBlock(this.toSerializableInfo(info.info))
	}

	private async renderMeme(
		key: string,
		text: string[] | undefined,
		ctx: ChatbotsCommandContext,
	): Promise<MessageContent> {
		try {
			await this.memeWorker.ready()
		} catch (e) {
			return `Meme generator not ready (${e instanceof Error ? e.message : String(e)})`
		}
		const info = this.resolveMemeInfo(key)
		if (!info.ok) return info.message

		const params = info.info.params
		const images = await this.collectMemeImages(ctx, params.minImages, params.maxImages)
		if (images.length < params.minImages) {
			const hint = await this.buildTelegramAvatarHint(ctx)
			return [
				`Need at least ${params.minImages} image(s). Provided ${images.length}. Attach images or mention users for avatars.${hint ? ` ${hint}` : ''}`,
				`Meme requires: images ${params.minImages}..${params.maxImages}, texts ${params.minTexts}..${params.maxTexts}.`,
			].join('\n')
		}

		const normalized = this.normalizeTexts(text, info.info)
		if (!normalized.ok) return normalized.message

		const res = await this.memeWorker.generateImage({
			key: info.info.key,
			images,
			texts: normalized.texts,
		})
		if (!res.ok) return res.message

		const ext =
			res.mime === 'image/gif'
				? 'gif'
				: res.mime === 'video/mp4'
					? 'mp4'
					: res.mime === 'image/webp'
						? 'webp'
						: res.mime === 'image/jpeg'
							? 'jpg'
							: 'png'

		const imagePart: Part = {
			type: 'image',
			data: res.buffer,
			mime: res.mime,
			name: `meme-${info.info.key}.${ext}`,
		}
		return imagePart
	}

	// (catalog image list removed: avoid Takumi dependency)

	private async buildTelegramAvatarHint(ctx: ChatbotsCommandContext): Promise<string> {
		if (ctx.msg.platform !== 'telegram') return ''
		const bot: any = ctx.msg.bot
		if (typeof bot?.getUserProfilePhotos !== 'function') {
			return 'Telegram: bot API unavailable to fetch profile photos.'
		}
		const userId = typeof ctx.msg.user?.id === 'number' ? ctx.msg.user.id : null
		if (!userId) return 'Telegram: missing user_id.'
		try {
			const res = await bot.getUserProfilePhotos({ user_id: userId, limit: 1 })
			if (!res?.ok) return `Telegram: getUserProfilePhotos not ok (${res?.message ?? 'unknown'}).`
			const total = (res.data as any)?.total_count
			if (typeof total === 'number' && total === 0) {
				return 'Telegram: bot sees your profile photos as empty (total_count=0). Check avatar privacy / set a profile photo.'
			}
			return ''
		} catch (e) {
			return `Telegram: getUserProfilePhotos failed (${e instanceof Error ? e.message : String(e)}).`
		}
	}

	private resolveMemeInfo(
		key: string,
	): { ok: true; info: MemeMetadata } | { ok: false; message: string } {
		const resolved = this.memeWorker.resolveMeme(String(key ?? '').trim())
		if (!resolved) return { ok: false, message: 'Unknown meme key.' }
		if (resolved.kind === 'choices') {
			return { ok: false, message: `Multiple matches: ${resolved.matches.join(', ')}` }
		}
		return { ok: true, info: resolved.info }
	}

	private normalizeTexts(
		text: string[] | undefined,
		info: MemeMetadata,
	): { ok: true; texts: string[] } | { ok: false; message: string } {
		const raw = (text ?? []).map((t) => t.trim()).filter(Boolean)
		const texts = raw.slice()

		const { minTexts, maxTexts, defaultTexts } = info.params
		if (texts.length < minTexts) {
			for (const fallback of defaultTexts) {
				if (texts.length >= minTexts) break
				if (fallback.trim()) texts.push(fallback)
			}
		}

		if (texts.length < minTexts) {
			return { ok: false, message: `Need at least ${minTexts} text(s).` }
		}
		if (texts.length > maxTexts) {
			return { ok: false, message: `Too many texts (max ${maxTexts}).` }
		}
		return { ok: true, texts }
	}

	private async collectMemeImages(
		ctx: ChatbotsCommandContext,
		minImages: number,
		maxImages: number,
	): Promise<MemeImage[]> {
		if (maxImages <= 0) return []

		const images: MemeImage[] = []
		const seen = new Set<string>()

		const avatars = await this.collectAvatarImages(ctx, maxImages, seen)
		images.push(...avatars)
		if (images.length >= minImages) return images

		const remaining = maxImages - images.length
		if (remaining <= 0) return images

		const attachments = await this.collectAttachmentImages(ctx, remaining, seen)
		images.push(...attachments)
		return images
	}

	private async collectAvatarImages(
		ctx: ChatbotsCommandContext,
		limit: number,
		seen: Set<string>,
	): Promise<MemeImage[]> {
		if (limit <= 0) return []

		const out: MemeImage[] = []
		const mentions = this.collectMentionParts(ctx.msg)
		const usedUserKeys = new Set<string>()

		const makeTrace = (label: string) => {
			if (ctx.msg.platform !== 'telegram') return null
			const events: AvatarTraceEvent[] = []
			return {
				events,
				trace: (e: AvatarTraceEvent) => events.push(e),
				label,
			}
		}

		const traces: Array<{ label: string; events: AvatarTraceEvent[] }> = []

		for (const mention of mentions) {
			if (out.length >= limit) break
			const key = this.userRefKey(ctx.msg.platform, mention)
			if (key && usedUserKeys.has(key)) continue
			if (key) usedUserKeys.add(key)

			const directUrl = mention.avatar ?? null
			if (directUrl && seen.has(directUrl)) continue

			let data: Buffer | null = null
			let dedupeKey: string | null = null

			if (directUrl) {
				data = await this.downloadBuffer(directUrl)
				dedupeKey = directUrl
			} else {
				const t = makeTrace(`mention:${this.pickMentionName(mention)}`)
				if (t) traces.push({ label: t.label, events: t.events })
				const img = await resolveUserAvatarImage(ctx.msg, mention, {
					trace: t?.trace,
				})
				if (img) {
					data = img.data
					dedupeKey = img.cacheKey ?? img.url ?? key
				}
			}

			if (!data) continue
			if (dedupeKey && seen.has(dedupeKey)) continue
			if (dedupeKey) seen.add(dedupeKey)
			const name = this.pickMentionName(mention)
			out.push({ name: `avatar-${name}`, data })
		}

		if (out.length < limit) {
			const authorKey = this.userRefKey(ctx.msg.platform, ctx.msg.user)
			if (!authorKey || !usedUserKeys.has(authorKey)) {
				if (authorKey) usedUserKeys.add(authorKey)
				const t = makeTrace('author')
				if (t) traces.push({ label: t.label, events: t.events })
				const img = await resolveAuthorAvatarImage(ctx.msg, {
					trace: t?.trace,
				})
				const dedupeKey = img?.cacheKey ?? img?.url ?? authorKey
				if (img?.data && (!dedupeKey || !seen.has(dedupeKey))) {
					if (dedupeKey) seen.add(dedupeKey)
					const name = ctx.msg.user.displayName ?? ctx.msg.user.username ?? 'author'
					out.push({ name: `avatar-${name}`, data: img.data })
				}
			}
		}

		if (ctx.msg.platform === 'telegram' && out.length === 0 && traces.length) {
			const summarize = (e: AvatarTraceEvent): string => {
				switch (e.kind) {
					case 'start':
						return `start prefer=${e.prefer} id=${String(e.ref.id ?? '')} username=${e.ref.username ?? ''}`
					case 'try':
						return `try ${e.step}`
					case 'ok':
						return `ok ${e.step} source=${e.source ?? ''} key=${e.cacheKey ?? ''}`
					case 'miss':
						return `miss ${e.step}${e.reason ? ` reason=${e.reason}` : ''}`
					case 'error':
						return `error ${e.step} msg=${e.message}`
					case 'fetch':
						return `fetch ok=${e.ok}${e.status ? ` status=${e.status}` : ''}${e.note ? ` note=${e.note}` : ''}`
					default:
						return JSON.stringify(e)
				}
			}

			const tracesText = traces.map((t) => ({
				label: t.label,
				events: t.events.map(summarize),
			}))
			this.ctx.logger.warn(
				{
					platform: ctx.msg.platform,
					mentions: mentions.map((m) => ({ id: m.id, username: m.username, displayName: m.displayName })),
					traces: tracesText,
				},
				'[meme-test] telegram avatar resolve returned empty',
			)
		}

		return out
	}

	private collectMentionParts(msg: ChatbotsCommandContext['msg']): MentionPart[] {
		const list = msg.mentions?.length ? msg.mentions : msg.parts
		return list.filter(
			(part): part is MentionPart => part.type === 'mention' && part.kind === 'user',
		)
	}

	private userRefKey(
		platform: ChatbotsCommandContext['msg']['platform'],
		ref: { id?: string | number | null; username?: string | null },
	): string | null {
		if (ref.id !== undefined && ref.id !== null) return `${platform}:id:${String(ref.id)}`
		const username = String(ref.username ?? '').trim()
		return username ? `${platform}:username:${username.toLowerCase()}` : null
	}

	private pickMentionName(mention: MentionPart): string {
		return mention.displayName ?? mention.username ?? String(mention.id ?? 'user')
	}

	private async collectAttachmentImages(
		ctx: ChatbotsCommandContext,
		limit: number,
		seen: Set<string>,
	): Promise<MemeImage[]> {
		if (limit <= 0) return []
		let attachments: ResolvedAttachment[] = []
		try {
			attachments = await resolveAttachments(ctx.msg, {
				limit,
				filter: (att) => att.kind === 'image',
				concurrency: Math.min(4, limit),
			})
		} catch (err) {
			this.ctx.logger.warn(err, '[meme-test] resolveAttachments failed')
		}

		const out: MemeImage[] = []
		for (const att of attachments) {
			if (out.length >= limit) break
			const key = this.getAttachmentKey(att)
			if (key && seen.has(key)) continue
			if (key) seen.add(key)
			out.push({ name: this.pickImageName(att.part, out.length), data: att.data })
		}
		return out
	}

	private async downloadBuffer(url: string): Promise<Buffer | null> {
		try {
			const res = await fetch(url)
			if (!res.ok) return null
			return Buffer.from(await res.arrayBuffer())
		} catch {
			return null
		}
	}

	private getAttachmentKey(att: ResolvedAttachment): string | null {
		const part: any = att.part ?? {}
		return part.url ?? part.fileId ?? part.name ?? null
	}

	private pickImageName(part: { name?: string; fileId?: string; url?: string }, index: number): string {
		if (part.name) return part.name
		if (part.fileId) return String(part.fileId)
		if (part.url) return part.url.split('/').pop() || `image-${index + 1}`
		return `image-${index + 1}`
	}

	private toSerializableInfo(info: MemeMetadata) {
		return {
			...info,
			tags: Array.from(info.tags ?? []),
			dateCreated: info.dateCreated?.toISOString?.() ?? info.dateCreated,
			dateModified: info.dateModified?.toISOString?.() ?? info.dateModified,
		}
	}

	private buildJsonBlock(payload: unknown): Part {
		return {
			type: 'codeblock',
			language: 'json',
			code: JSON.stringify(payload, null, 2),
		}
	}
}

export default MemeTest
