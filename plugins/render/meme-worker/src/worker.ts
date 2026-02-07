import { Buffer } from 'node:buffer'

import { getMeme, Resources, Tools, type Error as MemeGeneratorError, type MemeResult } from 'pluxel-plugin-napi-rs/meme-generator'

import type { MemeWorkerJob, MemeWorkerResult } from './types'

Resources.checkResourcesInBackground()

function describeGeneratorError(error: MemeGeneratorError): string {
	switch (error.type) {
		case 'ImageAssetMissing':
			return `缺少资源：${error.field0.path}`
		case 'ImageDecodeError':
			return String((error.field0 as any)?.error || '图片解码失败。')
		case 'ImageEncodeError':
			return String((error.field0 as any)?.error || '图片编码失败。')
		case 'DeserializeError':
			return String((error.field0 as any)?.error || '反序列化失败。')
		case 'ImageNumberMismatch':
			return `该模板需要 ${error.field0.min}~${error.field0.max} 张图片，实际提供了 ${error.field0.actual} 张。`
		case 'TextNumberMismatch':
			return `该模板允许 ${error.field0.min}~${error.field0.max} 段文字，实际提供了 ${error.field0.actual} 段。`
		case 'TextOverLength':
			return `存在超长文本：${error.field0.text}`
		case 'MemeFeedback':
			return String((error.field0 as any)?.feedback || '生成失败。')
		default:
			return '生成失败（未知错误）。'
	}
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
	// Always return a real ArrayBuffer (Buffer.buffer might be SharedArrayBuffer under some runtimes).
	const copy = new Uint8Array(buf.byteLength)
	copy.set(buf)
	return copy.buffer
}

export default async function run(job: MemeWorkerJob): Promise<MemeWorkerResult> {
	const started = Date.now()

	if (job.kind === 'listImage') {
		try {
			// Avoid accessing ambient const enums at runtime (`verbatimModuleSyntax`).
			const sortByMap = {
				Key: 0,
				Keywords: 1,
				KeywordsPinyin: 2,
				DateCreated: 3,
				DateModified: 4,
			} as const

			const sortBy =
				job.payload.sortBy != null ? (sortByMap[job.payload.sortBy] as unknown as Tools.MemeSortBy) : undefined

			const res = Tools.renderMemeList({
				sortBy,
				sortReverse: job.payload.sortReverse,
				textTemplate: job.payload.textTemplate,
				addCategoryIcon: job.payload.addCategoryIcon,
			})

			if (res.type === 'Err') {
				return { ok: false, message: describeGeneratorError(res.field0), durationMs: Date.now() - started }
			}

			const buffer = Buffer.from(res.field0)
			return { ok: true, buffer: toArrayBuffer(buffer), meta: { key: 'meme-list' }, durationMs: Date.now() - started }
		} catch (e) {
			return { ok: false, message: e instanceof Error ? e.message : '生成列表失败（未知错误）。', durationMs: Date.now() - started }
		}
	}

	const payload = job.payload
	const meme = getMeme(payload.key)
	if (!meme) {
		return { ok: false, message: `未找到模板：${payload.key}`, durationMs: Date.now() - started }
	}

	let result: MemeResult
	try {
		result = meme.generate(payload.images, payload.texts, {})
	} catch {
		return { ok: false, message: '生成表情失败，请稍后重试。', durationMs: Date.now() - started }
	}

	if (result.type === 'Err') {
		return { ok: false, message: describeGeneratorError(result.field0), durationMs: Date.now() - started }
	}

	const buffer = Buffer.from(result.field0)
	return { ok: true, buffer: toArrayBuffer(buffer), meta: { key: payload.key }, durationMs: Date.now() - started }
}
