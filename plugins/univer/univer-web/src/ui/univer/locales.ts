import { LocaleType, mergeLocales, type ILocales } from '@univerjs/core'
import designEnUS from '@univerjs/design/locale/en-US'
import designZhCN from '@univerjs/design/locale/zh-CN'
import docsUiEnUS from '@univerjs/docs-ui/locale/en-US'
import docsUiZhCN from '@univerjs/docs-ui/locale/zh-CN'
import sheetsEnUS from '@univerjs/sheets/locale/en-US'
import sheetsZhCN from '@univerjs/sheets/locale/zh-CN'
import sheetsFormulaUiEnUS from '@univerjs/sheets-formula-ui/locale/en-US'
import sheetsFormulaUiZhCN from '@univerjs/sheets-formula-ui/locale/zh-CN'
import sheetsUiEnUS from '@univerjs/sheets-ui/locale/en-US'
import sheetsUiZhCN from '@univerjs/sheets-ui/locale/zh-CN'
import uiEnUS from '@univerjs/ui/locale/en-US'
import uiZhCN from '@univerjs/ui/locale/zh-CN'

export function detectLocale(): LocaleType {
	const lang = typeof navigator !== 'undefined' ? String(navigator.language ?? '') : ''
	return lang.toLowerCase().startsWith('zh') ? LocaleType.ZH_CN : LocaleType.EN_US
}

export const UNIVER_LOCALES: ILocales = {
	[LocaleType.EN_US]: mergeLocales(
		designEnUS,
		uiEnUS,
		sheetsEnUS,
		sheetsUiEnUS,
		sheetsFormulaUiEnUS,
		docsUiEnUS,
	),
	[LocaleType.ZH_CN]: mergeLocales(
		designZhCN,
		uiZhCN,
		sheetsZhCN,
		sheetsUiZhCN,
		sheetsFormulaUiZhCN,
		docsUiZhCN,
	),
}

export function createUniverLocaleConfig() {
	return {
		locale: detectLocale(),
		locales: UNIVER_LOCALES,
	}
}
