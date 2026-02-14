import type { UniverToolGroup } from '../../protocol'
import { clampInt } from '../ints'

export type LoopLimits = Readonly<{ maxRows?: number; maxCols?: number }>

export { clampInt }

export function resolveLoopLimits(input: {
	limits?: LoopLimits
	instruction?: string
	groups?: readonly UniverToolGroup[]
}): Required<LoopLimits> {
	const userRows = input.limits?.maxRows
	const userCols = input.limits?.maxCols

	// Keep a conservative default; only auto-expand when we are likely doing data analysis/normalization.
	const base = {
		maxRows: typeof userRows === 'number' && Number.isFinite(userRows) ? clampInt(userRows, 1, 2000) : 40,
		maxCols: typeof userCols === 'number' && Number.isFinite(userCols) ? clampInt(userCols, 1, 2000) : 16,
	}

	if (typeof userRows === 'number' || typeof userCols === 'number') return base

	const text = String(input.instruction ?? '')
	const groups = new Set(input.groups ?? [])

	const looksLikeDataWork =
		/(汇总|统计|合计|总计|平均|均值|最大|最小|去重|去空|清洗|标准化|规范化|匹配|映射|分类|分组|透视|拆分|合并|填充|补全)/.test(text) ||
		/\b(sum|total|avg|mean|max|min|dedup|normalize|clean|group|pivot|join|merge|fill)\b/i.test(text)

	const wantsStructureOrStyle =
		groups.has('structure') ||
		groups.has('style') ||
		/(合并|merge|插入|删除行|删除列|行高|列宽|加粗|字体|颜色|边框|对齐|格式|style|format|bold|italic|underline)\b/i.test(text)

	if (looksLikeDataWork && !wantsStructureOrStyle) {
		return { maxRows: 80, maxCols: 24 }
	}

	return base
}
