import type { UniverRange } from '../../protocol'
import { parseA1Range } from '../a1'

export type RangeInput = {
	a1?: string
	sheetName?: string
	range?: UniverRange
}

export type SheetRef = {
	sheetId?: string
	sheetName?: string
}

export function resolveRangeInput(input: RangeInput): { range: UniverRange; a1?: string; sheetName?: string } {
	const a1 = String(input.a1 ?? '').trim()
	if (a1) {
		const parsed = parseA1Range(a1)
		return { range: parsed.range, a1: parsed.a1, sheetName: parsed.sheetName }
	}
	if (input.range) return { range: input.range }
	throw new Error('[univer] range or a1 required')
}

export function resolveSheet(workbook: any, sheetId?: string, sheetName?: string) {
	if (!workbook) throw new Error('[univer] workbook missing')
	if (sheetId) {
		const byId = workbook.getSheetBySheetId?.(sheetId)
		if (byId) return byId
	}
	if (sheetName) {
		const byName = workbook.getSheetByName?.(sheetName)
		if (byName) return byName
	}
	const active = workbook.getActiveSheet?.()
	if (active) return active
	const sheets = workbook.getSheets?.() ?? []
	if (Array.isArray(sheets) && sheets.length) return sheets[0]
	throw new Error('[univer] no sheets available')
}

export function getSheetId(sheet: any): string {
	const id = typeof sheet?.getSheetId === 'function' ? String(sheet.getSheetId()) : ''
	if (!id) throw new Error('[univer] invalid sheetId')
	return id
}

export function getSheetName(sheet: any): string {
	const name = typeof sheet?.getName === 'function' ? String(sheet.getName()) : ''
	return name || 'Sheet'
}

export function toMatrix(input: unknown): unknown[][] {
	if (!Array.isArray(input)) return []
	return input.map((row) => (Array.isArray(row) ? row.slice() : []))
}

export function toStringMatrix(input: unknown): string[][] {
	if (!Array.isArray(input)) return []
	return input.map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? '')) : []))
}

export function callFirst(obj: any, names: readonly string[], ...args: any[]) {
	for (const name of names) {
		const fn = obj?.[name]
		if (typeof fn === 'function') return fn.apply(obj, args)
	}
	return undefined
}

export function normalizeCount(value: unknown, min: number, max: number) {
	const v = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : min
	return Math.max(min, Math.min(max, v))
}
