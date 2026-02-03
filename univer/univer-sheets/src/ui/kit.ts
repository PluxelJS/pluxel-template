import '@univerjs/design/lib/index.css'
import '@univerjs/preset-sheets-core/lib/index.css'
import '@univerjs/preset-sheets-conditional-formatting/lib/index.css'
import '@univerjs/preset-sheets-data-validation/lib/index.css'
import '@univerjs/preset-sheets-filter/lib/index.css'
import '@univerjs/preset-sheets-find-replace/lib/index.css'
import '@univerjs/preset-sheets-hyper-link/lib/index.css'
import '@univerjs/preset-sheets-note/lib/index.css'
import '@univerjs/preset-sheets-sort/lib/index.css'
import '@univerjs/preset-sheets-table/lib/index.css'
import '@univerjs/preset-sheets-drawing/lib/index.css'
import '@univerjs/preset-sheets-thread-comment/lib/index.css'
import '@univerjs/sheets-crosshair-highlight/lib/index.css'
import '@univerjs/sheets-zen-editor/lib/index.css'
import '@univerjs/uniscript/lib/index.css'

import { createUniver, defaultTheme, LocaleType, mergeLocales } from '@univerjs/presets'
import { UniverSheetsConditionalFormattingPreset } from '@univerjs/preset-sheets-conditional-formatting'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import { UniverSheetsDataValidationPreset } from '@univerjs/preset-sheets-data-validation'
import { UniverSheetsFilterPreset } from '@univerjs/preset-sheets-filter'
import { UniverSheetsFindReplacePreset } from '@univerjs/preset-sheets-find-replace'
import { UniverSheetsHyperLinkPreset } from '@univerjs/preset-sheets-hyper-link'
import { UniverSheetsNotePreset } from '@univerjs/preset-sheets-note'
import { UniverSheetsSortPreset } from '@univerjs/preset-sheets-sort'
import { UniverSheetsTablePreset } from '@univerjs/preset-sheets-table'
import { UniverSheetsDrawingPreset } from '@univerjs/preset-sheets-drawing'
import { UniverSheetsThreadCommentPreset } from '@univerjs/preset-sheets-thread-comment'
import sheetsEnUS from '@univerjs/preset-sheets-core/locales/en-US'
import sheetsZhCN from '@univerjs/preset-sheets-core/locales/zh-CN'
import conditionalFormattingEnUS from '@univerjs/preset-sheets-conditional-formatting/locales/en-US'
import conditionalFormattingZhCN from '@univerjs/preset-sheets-conditional-formatting/locales/zh-CN'
import dataValidationEnUS from '@univerjs/preset-sheets-data-validation/locales/en-US'
import dataValidationZhCN from '@univerjs/preset-sheets-data-validation/locales/zh-CN'
import filterEnUS from '@univerjs/preset-sheets-filter/locales/en-US'
import filterZhCN from '@univerjs/preset-sheets-filter/locales/zh-CN'
import findReplaceEnUS from '@univerjs/preset-sheets-find-replace/locales/en-US'
import findReplaceZhCN from '@univerjs/preset-sheets-find-replace/locales/zh-CN'
import hyperLinkEnUS from '@univerjs/preset-sheets-hyper-link/locales/en-US'
import hyperLinkZhCN from '@univerjs/preset-sheets-hyper-link/locales/zh-CN'
import noteEnUS from '@univerjs/preset-sheets-note/locales/en-US'
import noteZhCN from '@univerjs/preset-sheets-note/locales/zh-CN'
import sortEnUS from '@univerjs/preset-sheets-sort/locales/en-US'
import sortZhCN from '@univerjs/preset-sheets-sort/locales/zh-CN'
import tableEnUS from '@univerjs/preset-sheets-table/locales/en-US'
import tableZhCN from '@univerjs/preset-sheets-table/locales/zh-CN'
import drawingEnUS from '@univerjs/preset-sheets-drawing/locales/en-US'
import drawingZhCN from '@univerjs/preset-sheets-drawing/locales/zh-CN'
import threadCommentEnUS from '@univerjs/preset-sheets-thread-comment/locales/en-US'
import threadCommentZhCN from '@univerjs/preset-sheets-thread-comment/locales/zh-CN'
import designEnUS from '@univerjs/design/locale/en-US'
import designZhCN from '@univerjs/design/locale/zh-CN'

import sheetsCrosshairHighlightEnUS from '@univerjs/sheets-crosshair-highlight/locale/en-US'
import sheetsCrosshairHighlightZhCN from '@univerjs/sheets-crosshair-highlight/locale/zh-CN'
import { UniverSheetsCrosshairHighlightPlugin } from '@univerjs/sheets-crosshair-highlight'
import '@univerjs/sheets-crosshair-highlight/facade'

import { UniverWatermarkPlugin } from '@univerjs/watermark'
import '@univerjs/watermark/facade'

import sheetsZenEditorEnUS from '@univerjs/sheets-zen-editor/locale/en-US'
import sheetsZenEditorZhCN from '@univerjs/sheets-zen-editor/locale/zh-CN'
import { UniverSheetsZenEditorPlugin } from '@univerjs/sheets-zen-editor'
import '@univerjs/sheets-zen-editor/facade'

import uniscriptEnUS from '@univerjs/uniscript/locale/en-US'
import uniscriptZhCN from '@univerjs/uniscript/locale/zh-CN'
import { UniverUniscriptPlugin } from '@univerjs/uniscript'

import type { SheetsHubSettings } from '../hub'
import type { SheetsPatchSpec, TextWatermarkSettings } from '../types'

export type SheetsUniverApi = ReturnType<typeof createUniver>['univerAPI']

export function createSheetsUniver(input: { container: HTMLDivElement; settings: SheetsHubSettings }): SheetsUniverApi {
	const { container, settings } = input
	const localeType = settings.locale === 'en-US' ? LocaleType.EN_US : LocaleType.ZH_CN
	const pickLocale = <T,>(en: T, zh: T) => (settings.locale === 'en-US' ? en : zh)

	type CreateUniverOptions = Parameters<typeof createUniver>[0]
	type LocalePack = Parameters<typeof mergeLocales>[0]
	type PresetItem = CreateUniverOptions['presets'][number]
	type PluginItem = NonNullable<CreateUniverOptions['plugins']>[number]

	const localePacks: LocalePack[] = [pickLocale(designEnUS, designZhCN), pickLocale(sheetsEnUS, sheetsZhCN)]
	const presets: CreateUniverOptions['presets'] = [UniverSheetsCorePreset({ container })]
	const plugins: NonNullable<CreateUniverOptions['plugins']> = [UniverWatermarkPlugin]

	const enablePreset = (enabled: boolean, preset: PresetItem, localeEn: LocalePack, localeZh: LocalePack) => {
		if (!enabled) return
		localePacks.push(pickLocale(localeEn, localeZh))
		presets.push(preset)
	}
	const enablePlugin = (enabled: boolean, plugin: PluginItem, localeEn: LocalePack, localeZh: LocalePack) => {
		if (!enabled) return
		localePacks.push(pickLocale(localeEn, localeZh))
		plugins.push(plugin)
	}

	enablePreset(settings.enableFilter, UniverSheetsFilterPreset(), filterEnUS, filterZhCN)
	enablePreset(settings.enableSort, UniverSheetsSortPreset(), sortEnUS, sortZhCN)
	enablePreset(settings.enableFindReplace, UniverSheetsFindReplacePreset(), findReplaceEnUS, findReplaceZhCN)
	enablePreset(settings.enableNote, UniverSheetsNotePreset(), noteEnUS, noteZhCN)
	enablePreset(settings.enableHyperLink, UniverSheetsHyperLinkPreset(), hyperLinkEnUS, hyperLinkZhCN)
	enablePreset(settings.enableDataValidation, UniverSheetsDataValidationPreset(), dataValidationEnUS, dataValidationZhCN)
	enablePreset(settings.enableTable, UniverSheetsTablePreset(), tableEnUS, tableZhCN)
	enablePreset(settings.enableDrawing, UniverSheetsDrawingPreset(), drawingEnUS, drawingZhCN)
	enablePreset(settings.enableThreadComment, UniverSheetsThreadCommentPreset(), threadCommentEnUS, threadCommentZhCN)
	enablePreset(
		settings.enableConditionalFormatting,
		UniverSheetsConditionalFormattingPreset(),
		conditionalFormattingEnUS,
		conditionalFormattingZhCN,
	)

	enablePlugin(
		settings.enableCrosshairHighlight,
		UniverSheetsCrosshairHighlightPlugin,
		sheetsCrosshairHighlightEnUS,
		sheetsCrosshairHighlightZhCN,
	)
	enablePlugin(settings.enableZenEditor, UniverSheetsZenEditorPlugin, sheetsZenEditorEnUS, sheetsZenEditorZhCN)
	enablePlugin(settings.enableUniscript, UniverUniscriptPlugin, uniscriptEnUS, uniscriptZhCN)

	const { univerAPI } = createUniver({
		locale: localeType,
		locales: { [localeType]: mergeLocales(...localePacks) },
		theme: defaultTheme,
		presets,
		plugins,
	})

	univerAPI.createWorkbook({})
	return univerAPI
}

export function applyTextWatermark(api: SheetsUniverApi, watermark: TextWatermarkSettings | null): void {
	if (!watermark) {
		api.deleteWatermark()
		return
	}

	api.addWatermark(api.Enum.IWatermarkTypeEnum.Text, {
		content: watermark.content,
		repeat: watermark.repeat ?? true,
		x: 80,
		y: 60,
		spacingX: 260,
		spacingY: 190,
		rotate: watermark.rotate ?? -15,
		opacity: watermark.opacity ?? 0.2,
		fontSize: watermark.fontSize ?? 28,
		color: watermark.color ?? 'rgba(120, 120, 120, 0.28)',
		bold: false,
		italic: false,
		direction: 'ltr',
	})
}

export function applySheetsPatch(api: SheetsUniverApi, spec: SheetsPatchSpec): void {
	const workbook = api.getActiveWorkbook()
	if (!workbook) throw new Error('No active workbook')

	for (const action of spec.actions) {
		const sheet = action.sheetName ? workbook.getSheetByName(action.sheetName) : workbook.getActiveSheet()
		if (!sheet) throw new Error(action.sheetName ? `Sheet not found: ${action.sheetName}` : 'No active sheet')

		const range = sheet.getRange(action.range)
		if (action.op === 'set') {
			range.setValue(action.value)
			continue
		}
		if (action.op === 'setValues') {
			range.setValues(action.values)
			continue
		}
		if (action.op === 'clear') {
			range.clearContent()
			continue
		}
	}
}
