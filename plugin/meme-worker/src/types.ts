import type { Buffer } from 'node:buffer'
import type { Image as MemeImage, MemeInfo } from 'pluxel-plugin-napi-rs/meme-generator'

export interface MemeRenderPayload {
	key: string
	images: MemeImage[]
	texts: string[]
}

export type MemeWorkerJob = { kind: 'meme'; payload: MemeRenderPayload }

export type MemeWorkerResult =
	| { ok: true; buffer: ArrayBuffer; durationMs: number; meta: { key: string } }
	| { ok: false; message: string; durationMs: number }

export type MemeRenderResult = MemeWorkerResult

export type MemeImageResult =
	| { ok: true; buffer: Buffer; mime: string; durationMs: number; meta: { key: string } }
	| { ok: false; message: string; durationMs: number }

export type MemeMetadata = MemeInfo

export type MemeResolveResult =
	| { kind: 'exact'; info: MemeMetadata }
	| { kind: 'choices'; matches: string[] }
	| null
