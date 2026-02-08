import type { Univer as UniverCtor } from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import { IWatermarkTypeEnum } from '@univerjs/engine-render'
import {
	WatermarkTextBaseConfig,
	type IUniverWatermarkConfig,
} from '@univerjs/watermark'

import { isRecord } from '../shared'

function parseWatermarkConfig(value: unknown): Pick<
	NonNullable<IUniverWatermarkConfig['textWatermarkSettings']>,
	'content' | 'fontSize'
> | null {
	if (!isRecord(value)) return null
	const settings = value.textWatermarkSettings
	if (!isRecord(settings)) return null
	const content = settings.content
	if (typeof content !== 'string' || !content.trim()) return null
	const fontSize = settings.fontSize
	return {
		content,
		fontSize: typeof fontSize === 'number' ? fontSize : undefined,
	}
}

export function createWatermarkController(univer: UniverCtor, enabled: boolean) {
	let cleanup: (() => void) | null = null

	const clear = () => {
		if (!enabled) return
		cleanup?.()
		cleanup = null
	}

	const apply = (config: unknown) => {
		if (!enabled) return
		const text = parseWatermarkConfig(config)
		if (!text) {
			clear()
			return
		}

		clear()

		const api = FUniver.newAPI(univer)
		api.addWatermark(IWatermarkTypeEnum.Text, {
			...WatermarkTextBaseConfig,
			content: text.content,
			fontSize: text.fontSize ?? WatermarkTextBaseConfig.fontSize,
		})
		cleanup = () => {
			api.deleteWatermark()
		}
	}

	return {
		apply,
		clear,
	}
}
