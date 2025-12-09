import { BasePlugin, Config, Plugin } from '@pluxel/hmr'
import { v } from '@pluxel/hmr/config'
import { Buffer } from 'node:buffer'
import { MemeWorker, type MemeMetadata, type MemeResolveResult, type Image as MemeImage } from 'pluxel-plugin-meme-worker'
import { TelegramPlugin, type Message, type MessageSession } from 'pluxel-plugin-telegram'

const TEXT_SEPARATOR = '|'
const CfgSchema = v.object({
	/** 未来可扩展配置 */
	enabled: v.optional(v.boolean(), true),
})

interface ParsedArgs {
	identifier: string
	texts: string[]
}

interface FileSource {
	fileId: string
	filename?: string
}

@Plugin({ name: 'meme-bot' })
export class MemeBot extends BasePlugin {
	@Config(CfgSchema)
	private config!: Config<typeof CfgSchema>

	private readonly telegram: TelegramPlugin
	private readonly memeWorker: MemeWorker
	private readonly disposers: Array<() => void> = []

	constructor(telegram: TelegramPlugin, memeWorker: MemeWorker) {
		super()
		this.telegram = telegram
		this.memeWorker = memeWorker
	}

	async init(_abort: AbortSignal): Promise<void> {
		if (!this.config.enabled) {
			this.ctx.logger.warn('MemeBot disabled via config')
			return
		}

		this.registerCommands()
		this.ctx.logger.info('MemeBot initialized')
	}

	async stop(_abort: AbortSignal): Promise<void> {
		while (this.disposers.length > 0) {
			const dispose = this.disposers.pop()
			try {
				dispose?.()
			} catch (e) {
				this.ctx.logger.warn(e, 'meme-bot: 清理资源失败')
			}
		}
		this.ctx.logger.info('MemeBot stopped')
	}

	private registerCommands() {
		const unregister = this.telegram.runtime.commands.register({
			command: 'meme',
			description: '生成 meme 图片',
			handler: (session, args) => this.handleMemeCommand(session, args),
		})

		this.disposers.push(unregister)
	}

	private async handleMemeCommand(session: MessageSession, rawArgs: string) {
		const parsed = this.parseArgs(rawArgs)
		if (!parsed) {
			return this.buildUsage()
		}

		const resolved = this.resolveMeme(parsed.identifier)
		if (!resolved) {
			return this.buildNotFoundMessage(parsed.identifier)
		}

		if (resolved.kind === 'choices') {
			return this.buildSuggestionMessage(parsed.identifier, resolved.matches)
		}

		const textResult = this.prepareTexts(resolved.info, parsed.texts)
		if (!textResult.ok) {
			return textResult.message
		}

		const imageResult = await this.prepareImages(session, resolved.info.params.minImages, resolved.info.params.maxImages)
		if (!imageResult.ok) {
			return imageResult.message
		}

		const chat = session.bot.createChatSession(session.chatId)
		void chat.typing('upload_photo').catch(() => {})

		const generation = await this.renderMeme(resolved.info.key, imageResult.images, textResult.texts)
		if (!generation.ok) {
			return generation.message
		}

		const caption = `🎭 ${resolved.info.key}`
		const sendResult = await chat.sendPhoto(
			{ data: generation.buffer, filename: `${resolved.info.key}.png`, contentType: 'image/png' },
			{ caption },
		)

		if (!sendResult.ok) {
			this.ctx.logger.error({ err: sendResult }, 'meme-bot: 发送图片失败')
			return `图片发送失败：${sendResult.message}`
		}

		this.ctx.logger.info(
			{
				meme: resolved.info.key,
				durationMs: generation.durationMs,
				images: imageResult.images.length,
				texts: textResult.texts.length,
			},
			'meme-bot: 生成并发送完成',
		)

		return undefined
	}

	private parseArgs(raw: string): ParsedArgs | null {
		const trimmed = raw.trim()
		if (!trimmed) return null

		const spaceIndex = trimmed.indexOf(' ')
		const identifier = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)
		const textSegment = spaceIndex === -1 ? '' : trimmed.slice(spaceIndex + 1)
		const texts = textSegment
			.split(TEXT_SEPARATOR)
			.map((t) => t.trim())
			.filter((t) => t.length > 0)

		return {
			identifier,
			texts,
		}
	}

	private resolveMeme(identifier: string): MemeResolveResult {
		return this.memeWorker.resolveMeme(identifier)
	}

	private prepareTexts(meme: MemeMetadata, provided: string[]): { ok: true; texts: string[] } | { ok: false; message: string } {
		const { minTexts, maxTexts, defaultTexts } = meme.params
		const texts = [...provided]

		if (texts.length === 0 && defaultTexts.length > 0) {
			texts.push(...defaultTexts)
		}

		if (texts.length < minTexts && defaultTexts.length > 0) {
			for (const defaults of defaultTexts) {
				if (texts.length >= minTexts) break
				texts.push(defaults)
			}
		}

		if (texts.length < minTexts) {
			return {
				ok: false,
				message: `模板 ${meme.key} 至少需要 ${minTexts} 段文字，请使用 “${TEXT_SEPARATOR}” 分隔不同语句。`,
			}
		}

		if (texts.length > maxTexts) {
			texts.length = maxTexts
		}

		return { ok: true, texts }
	}

	private async prepareImages(
		session: MessageSession,
		minImages: number,
		maxImages: number,
	): Promise<{ ok: true; images: MemeImage[] } | { ok: false; message: string }> {
		const sources = this.collectImageSources(session.message)
		if (minImages > 0 && sources.length < minImages) {
			return {
				ok: false,
				message: `模板需要至少 ${minImages} 张图片，请在指令消息或引用的消息中附带图片。`,
			}
		}

		const maxAllowed = maxImages > 0 ? maxImages : sources.length
		const finalSources = sources.slice(0, Math.min(maxAllowed, sources.length))

		if (finalSources.length === 0) {
			return { ok: true, images: [] }
		}

		try {
			const images = await Promise.all(finalSources.map((source, index) => this.downloadTelegramFile(session, source, index)))
			return { ok: true, images }
		} catch (e) {
			this.ctx.logger.error(e, 'meme-bot: 下载图片失败')
			return { ok: false, message: '图片下载失败，请稍后再试。' }
		}
	}

	private collectImageSources(message?: Message | null, seen = new Set<string>(), acc: FileSource[] = []): FileSource[] {
		if (!message) return acc

		const push = (fileId: string, filename?: string) => {
			if (!fileId || seen.has(fileId)) return
			seen.add(fileId)
			acc.push({ fileId, filename })
		}

		if (Array.isArray(message.photo) && message.photo.length > 0) {
			const largest = message.photo[message.photo.length - 1]
			push(largest.file_id, largest.file_unique_id ? `${largest.file_unique_id}.jpg` : undefined)
		}

		const document = message.document
		if (document && typeof document.mime_type === 'string' && document.mime_type.startsWith('image/')) {
			push(document.file_id, document.file_name)
		}

		if (message.animation && message.animation.mime_type?.startsWith('image/')) {
			push(message.animation.file_id, message.animation.file_name)
		}

		if (message.sticker && message.sticker.is_video === false && message.sticker.is_animated === false) {
			push(message.sticker.file_id, `${message.sticker.file_unique_id}.webp`)
		}

		if (message.reply_to_message) {
			this.collectImageSources(message.reply_to_message, seen, acc)
		}

		return acc
	}

	private async downloadTelegramFile(session: MessageSession, source: FileSource, index: number): Promise<MemeImage> {
		const info = await session.bot.getFile({ file_id: source.fileId })
		if (!info.ok || !info.data.file_path) {
			throw new Error(`无法获取文件信息：${source.fileId}`)
		}

		const url = this.resolveFileUrl(session, info.data.file_path)
		const response = await fetch(url)
		if (!response.ok) {
			throw new Error(`获取文件失败：${response.status}`)
		}
		const arrayBuffer = await response.arrayBuffer()
		const data = Buffer.from(arrayBuffer)
		const name = source.filename || info.data.file_path.split('/').pop() || `image-${index + 1}.png`

		return {
			name,
			data,
		}
	}

	private resolveFileUrl(session: MessageSession, filePath: string) {
		const base = session.bot.apiBase.replace(/\/+$/, '')
		const token = session.bot.token
		return `${base}/file/bot${token}/${filePath.replace(/^\/+/, '')}`
	}

	private async renderMeme(
		memeKey: string,
		images: MemeImage[],
		texts: string[],
	): Promise<
		| { ok: true; buffer: Buffer; durationMs?: number; meta?: { key: string } }
		| { ok: false; message: string }
	> {
		try {
			const result = await this.memeWorker.generateImage({ key: memeKey, images, texts })
			if (!result.ok) {
				return { ok: false as const, message: result.message }
			}
			return { ok: true as const, buffer: result.buffer, durationMs: result.durationMs, meta: result.meta }
		} catch (e) {
			this.ctx.logger.error(e, 'meme-bot: 渲染表情失败')
			return { ok: false as const, message: '生成表情失败，请稍后再试。' }
		}
	}

	private buildUsage() {
		return [
			'使用方式：/meme <模板关键字或搜索词> 文本1 | 文本2 ...',
			`示例：/meme drake 我不要上班 ${TEXT_SEPARATOR} 我只想摸鱼`,
			'如果模板需要图片，请在同条或被引用的消息里附带图片。',
			'使用 /meme <关键词> 以获取可能的模板，或输入 /meme random 随机挑一个。',
		].join('\n')
	}

	private buildNotFoundMessage(identifier: string) {
		return `没有找到和 “${identifier}” 匹配的模板，可尝试使用更准确的关键词或 /meme <关键字> 重新搜索。`
	}

	private buildSuggestionMessage(identifier: string, matches: string[]) {
		const list = matches.map((key, index) => `${index + 1}. ${key}`).join('\n')
		return [
			`没有直接匹配 “${identifier}”，猜测你想要的是：`,
			list,
			'可直接输入 /meme <上述模板> 文本 来生成。',
		].join('\n')
	}
}

export default MemeBot
