// @ts-check
import { Buffer } from 'node:buffer'
import { getMeme, Resources } from 'pluxel-plugin-napi-rs/meme-generator'

/** @typedef {import('./types').MemeWorkerJob} MemeWorkerJob */
/** @typedef {import('./types').MemeWorkerResult} MemeWorkerResult */
/** @typedef {import('pluxel-plugin-napi-rs/meme-generator').Error} MemeGeneratorError */
/** @typedef {import('pluxel-plugin-napi-rs/meme-generator').MemeResult} MemeResult */

Resources.checkResourcesInBackground()

/**
 * @param {MemeGeneratorError} error
 */
function describeGeneratorError(error) {
	switch (error.type) {
		case 'ImageNumberMismatch':
			return `该模板需要 ${error.field0.min}~${error.field0.max} 张图片，实际提供了 ${error.field0.actual} 张。`
		case 'TextNumberMismatch':
			return `该模板允许 ${error.field0.min}~${error.field0.max} 段文字，实际提供了 ${error.field0.actual} 段。`
		case 'TextOverLength':
			return `存在超长文本：${error.field0.text}`
		case 'MemeFeedback':
			return error.field0.feedback
		default:
			return '生成表情失败（未知错误）。'
	}
}

/**
 * @param {MemeWorkerJob} job
 * @returns {Promise<MemeWorkerResult>}
 */
export default async function run(job) {
	const started = Date.now()
	const payload = job.payload
	const meme = getMeme(payload.key)
	if (!meme) {
		return { ok: false, message: `未找到模板：${payload.key}`, durationMs: Date.now() - started }
	}

	/** @type {MemeResult} */
	let result
	try {
		result = meme.generate(payload.images, payload.texts, {})
	} catch (err) {
		return { ok: false, message: '生成表情失败，请稍后重试。', durationMs: Date.now() - started }
	}

	if (result.type === 'Err') {
		return { ok: false, message: describeGeneratorError(result.field0), durationMs: Date.now() - started }
	}

	const buffer = Buffer.from(result.field0)
	return {
		ok: true,
		buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
		meta: { key: payload.key },
		durationMs: Date.now() - started,
	}
}
