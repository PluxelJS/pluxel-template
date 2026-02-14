import type { UniverToolGroup, UniverToolIndexMode } from '../../protocol'
import { clampInt, parseEnvInt } from '../ints'

export const UNIVER_LOOPBACK_TOOL_GROUPS: readonly UniverToolGroup[] = [
	'core',
	'data',
	'sheet',
	'structure',
	'style',
]

export const UNIVER_LOOPBACK_BASE_TOOL_GROUPS: readonly UniverToolGroup[] = ['core', 'data', 'sheet']

export const UNIVER_LOOPBACK_MAX_STEPS_TOTAL = 80
export const UNIVER_LOOPBACK_MAX_ATTEMPTS = 2
export const UNIVER_LOOPBACK_MAX_STEPS_PER_ATTEMPT = Math.floor(UNIVER_LOOPBACK_MAX_STEPS_TOTAL / UNIVER_LOOPBACK_MAX_ATTEMPTS)

export const UNIVER_LOOPBACK_QA_CONFIDENCE_THRESHOLD = 0.7

export function resolveToolIndexMode(groupsCount: number): UniverToolIndexMode {
	return groupsCount <= 2 ? 'tools' : 'groups'
}

export function resolveUniverLoopbackToolGroups(instruction: string): readonly UniverToolGroup[] {
	const text = String(instruction ?? '')
	const wantsStructure =
		/(插入|删除行|删除列|合并单元格|取消合并|冻结|取消冻结|隐藏行|隐藏列|重命名工作表|merge cells?|insert row|insert column|delete row|delete column|freeze)/i.test(
			text,
		)
	const wantsStyle =
		/(行高|列宽|加粗|字体|颜色|边框|对齐|格式|条件格式|高亮|style|format|bold|italic|underline|border|align)/i.test(text)

	const base = [...UNIVER_LOOPBACK_BASE_TOOL_GROUPS]
	if (wantsStructure) base.push('structure')
	if (wantsStyle) base.push('style')
	return base
}

export type UniverLoopbackBudgets = Readonly<{
	maxStepsTotal: number
	maxAttempts: number
	maxStepsPerAttempt: number
}>

/**
 * Resolve loopback budgets for the current run.
 *
 * Defaults are intentionally conservative, but we allow a small automatic bump for
 * "data work" tasks when scopes are already narrow (to avoid encouraging sheet-wide scans).
 *
 * Dev override:
 * - `UNIVER_LOOPBACK_MAX_STEPS_TOTAL=120`
 */
export function resolveUniverLoopbackBudgets(input: Readonly<{
	instruction: string
	readScopesCount: number
	writeScopesCount: number
}>): UniverLoopbackBudgets {
	const envTotal = parseEnvInt('UNIVER_LOOPBACK_MAX_STEPS_TOTAL')
	const baseTotal = clampInt(envTotal ?? UNIVER_LOOPBACK_MAX_STEPS_TOTAL, 40, 400)
	const maxAttempts = UNIVER_LOOPBACK_MAX_ATTEMPTS

	let maxStepsTotal = baseTotal
	const text = String(input.instruction ?? '')
	const readScopesCount = clampInt(input.readScopesCount, 0, 1000)
	const writeScopesCount = clampInt(input.writeScopesCount, 0, 1000)

	const looksLikeDataWork =
		/(汇总|统计|合计|总计|平均|均值|最大|最小|去重|去空|清洗|标准化|规范化|匹配|映射|分类|分组|透视|拆分|合并|填充|补全)/.test(text) ||
		/\b(sum|total|avg|mean|max|min|dedup|normalize|clean|group|pivot|join|merge|fill)\b/i.test(text)
	const looksLikeStructureOrStyle =
		/(合并单元格|merge cells?|插入行|插入列|删除行|删除列|行高|列宽|加粗|字体|颜色|边框|对齐|格式|style|format|bold|italic|underline)\b/i.test(text)

	// Automatic bump only when the user already narrowed the problem.
	if (!envTotal && looksLikeDataWork && !looksLikeStructureOrStyle && writeScopesCount > 0 && readScopesCount > 0 && readScopesCount <= 2) {
		maxStepsTotal = Math.max(maxStepsTotal, 120)
	}

	const maxStepsPerAttempt = clampInt(Math.floor(maxStepsTotal / Math.max(1, maxAttempts)), 10, 240)
	return { maxStepsTotal, maxAttempts, maxStepsPerAttempt }
}
