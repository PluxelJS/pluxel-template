import { FUniver } from '@univerjs/core/facade'
import { IUndoRedoService, type IDisposable, Univer as UniverCtor } from '@univerjs/core'
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula'
import { IWatermarkTypeEnum, UniverRenderEnginePlugin } from '@univerjs/engine-render'
import { UniverSheetsPlugin } from '@univerjs/sheets'
import { UniverSheetsUIPlugin } from '@univerjs/sheets-ui'
import { UniverUIPlugin } from '@univerjs/ui'
import {
	UniverWatermarkPlugin,
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

export type UniverRuntime = {
	univer: UniverCtor
	api: FUniver
	workbookId: string
	workbookName: string
	installedPlugins: ReadonlySet<string>
	dispose(): void
	applyWatermark(config: unknown): void
	clearWatermark(): void
	clearOverlay(): void
	highlightRange(input: {
		sheetId?: string | null
		range: { startRow: number; startCol: number; endRow: number; endCol: number }
		style?: unknown
		durationMs?: number
	}): void
	withUndoBatch<T>(fn: () => Promise<T> | T): Promise<T>
	saveSnapshotJson(): string
}

export function createUniverRuntime(input: {
	mountEl: HTMLElement
	workbookId: string
	workbookName: string
	snapshot?: unknown
	installedPlugins?: readonly string[]
}): UniverRuntime {
	const univer = new UniverCtor({})
	const installedPlugins = new Set(input.installedPlugins ?? [])

	// Minimal Sheets composition.
	univer.registerPlugin(UniverRenderEnginePlugin)
	univer.registerPlugin(UniverFormulaEnginePlugin)
	univer.registerPlugin(UniverUIPlugin, { container: input.mountEl })
	univer.registerPlugin(UniverSheetsPlugin)
	univer.registerPlugin(UniverSheetsUIPlugin)

	// Optional Univer plugins (pure-frontend, enabled by backend SSE).
	const watermarkInstalled = installedPlugins.has('watermark')
	if (watermarkInstalled) {
		// Register only if enabled; we recreate runtime to "unregister".
		univer.registerPlugin(UniverWatermarkPlugin)
	}

	const api = FUniver.newAPI(univer)
	api.createWorkbook(
		isRecord(input.snapshot) ? (input.snapshot as any) : { id: input.workbookId, name: input.workbookName },
	)

	let watermarkCleanup: (() => void) | null = null

	let overlayDispose: IDisposable | null = null
	let overlayTimer: number | null = null

	const clearWatermark = () => {
		if (!watermarkInstalled) return
		watermarkCleanup?.()
		watermarkCleanup = null
	}

	const clearOverlay = () => {
		if (overlayTimer) window.clearTimeout(overlayTimer)
		overlayTimer = null
		overlayDispose?.dispose()
		overlayDispose = null
	}

	const applyWatermark = (config: unknown) => {
		if (!watermarkInstalled) return
		const text = parseWatermarkConfig(config)
		if (!text) {
			clearWatermark()
			return
		}

		clearWatermark()

		const api = FUniver.newAPI(univer)
		api.addWatermark(IWatermarkTypeEnum.Text, {
			...WatermarkTextBaseConfig,
			content: text.content,
			fontSize: text.fontSize ?? WatermarkTextBaseConfig.fontSize,
		})
		watermarkCleanup = () => {
			api.deleteWatermark()
		}
	}

	const saveSnapshotJson = () => {
		const fWorkbook = api.getActiveWorkbook()
		if (!fWorkbook) throw new Error('[univer] no active workbook')
		const snapshot = fWorkbook.save()
		return JSON.stringify(snapshot)
	}

	const withUndoBatch = async <T,>(fn: () => Promise<T> | T): Promise<T> => {
		const fWorkbook = api.getActiveWorkbook()
		const unitId = fWorkbook?.getId() ?? input.workbookId
		const injector = univer.__getInjector()
		const undoRedo = injector.get(IUndoRedoService)
		const batching = undoRedo.__tempBatchingUndoRedo(unitId)
		try {
			return await fn()
		} finally {
			batching.dispose()
		}
	}

	const highlightRange: UniverRuntime['highlightRange'] = ({ sheetId, range, style, durationMs }) => {
		clearOverlay()

		const fWorkbook = api.getActiveWorkbook()
		if (!fWorkbook) return

		const fWorksheet = sheetId ? fWorkbook.getSheetBySheetId(sheetId) : fWorkbook.getActiveSheet()
		if (!fWorksheet) return

		if (sheetId) fWorkbook.setActiveSheet(sheetId)

		try {
			fWorksheet.scrollToCell(range.startRow, range.startCol, 120)
		} catch {
			// best-effort; scrolling is UI-only.
		}

		const fRange = fWorksheet.getRange({
			startRow: range.startRow,
			startColumn: range.startCol,
			endRow: range.endRow,
			endColumn: range.endCol,
		})
		const primaryRange = fWorksheet.getRange({
			startRow: range.startRow,
			startColumn: range.startCol,
			endRow: range.startRow,
			endColumn: range.startCol,
		}).getRange()

		overlayDispose = (fRange as any).highlight(style ?? null, {
			...primaryRange,
			actualRow: primaryRange.startRow,
			actualColumn: primaryRange.startColumn,
		})

		const ms = typeof durationMs === 'number' && Number.isFinite(durationMs) ? Math.max(0, Math.floor(durationMs)) : 0
		if (ms > 0) {
			overlayTimer = window.setTimeout(() => {
				overlayTimer = null
				clearOverlay()
			}, ms)
		}
	}

	const dispose = () => {
		clearOverlay()
		clearWatermark()
		api.dispose()
		univer.dispose()
	}

	return {
		univer,
		api,
		workbookId: input.workbookId,
		workbookName: input.workbookName,
		installedPlugins,
		dispose,
		applyWatermark,
		clearWatermark,
		clearOverlay,
		highlightRange,
		withUndoBatch,
		saveSnapshotJson,
	}
}
