import { UNIVER_AI_DEFAULT_CONTRACT_LIMITS } from './ai'
import type { UniverAiChangeSet, UniverAiEditContract, UniverAiOpsV1, UniverAiRange, UniverAiWriteScope } from './ai'

function clampInt(n: unknown, min: number, max: number) {
	const v = typeof n === 'number' && Number.isFinite(n) ? n : min
	return Math.max(min, Math.min(max, Math.floor(v)))
}

function rangeContainsCell(range: UniverAiRange, row: number, col: number) {
	return row >= range.startRow && row <= range.endRow && col >= range.startCol && col <= range.endCol
}

function rangesOverlap(a: UniverAiRange, b: UniverAiRange) {
	return a.startRow <= b.endRow && a.endRow >= b.startRow && a.startCol <= b.endCol && a.endCol >= b.startCol
}

export function normalizeUniverAiContractLimits(limits?: UniverAiEditContract['limits']): { maxChanges: number; maxOps: number } {
	const maxChanges =
		typeof limits?.maxChanges === 'number' && Number.isFinite(limits.maxChanges)
			? clampInt(limits.maxChanges, 1, 80)
			: UNIVER_AI_DEFAULT_CONTRACT_LIMITS.maxChanges
	const maxOps =
		typeof limits?.maxOps === 'number' && Number.isFinite(limits.maxOps)
			? clampInt(limits.maxOps, 1, 20_000)
			: UNIVER_AI_DEFAULT_CONTRACT_LIMITS.maxOps
	return { maxChanges, maxOps }
}

/**
 * Runtime validator: ensures a ChangeSet stays within the given edit contract.
 *
 * This MUST be enforced on the backend before applying to a workbook snapshot.
 */
export function assertUniverAiChangeSetWithinContract(changeSet: UniverAiChangeSet, contract: UniverAiEditContract): void {
	const scopesById = new Map<string, UniverAiWriteScope>()
	for (const s of contract.writeScopes ?? []) {
		if (!s || typeof s.id !== 'string' || !s.id.trim()) continue
		scopesById.set(s.id, s)
	}

	const { maxChanges, maxOps } = normalizeUniverAiContractLimits(contract.limits)

	const changes = Array.isArray(changeSet?.changes) ? changeSet.changes : []
	if (changes.length > maxChanges) {
		throw new Error(`[univer] changes exceed contract limit: ${changes.length} > ${maxChanges}`)
	}

	let totalOps = 0
	const seenScopeIds = new Set<string>()
	const editedCells = new Set<string>()

	// Prevent clear-scope overlaps with any other change scopes on the same sheet.
	const clearScopes: UniverAiWriteScope[] = []
	const otherScopes: UniverAiWriteScope[] = []

	for (const ch of changes) {
		const scope = scopesById.get(ch.scopeId)
		if (!scope) throw new Error(`[univer] change scope not found: ${ch.scopeId}`)
		if (seenScopeIds.has(ch.scopeId)) throw new Error(`[univer] duplicate scopeId in changes: ${ch.scopeId}`)
		seenScopeIds.add(ch.scopeId)

		if (ch.op === 'clear') {
			clearScopes.push(scope)
			continue
		}

		if (ch.op !== 'setValues') throw new Error(`[univer] unknown change op: ${(ch as any).op}`)
		if (!ch.value || ch.value.kind !== 'ops-v1' || !Array.isArray(ch.value.ops)) {
			throw new Error(`[univer] invalid setValues payload for scope: ${ch.scopeId}`)
		}
		if (!ch.value.ops.length) throw new Error(`[univer] setValues ops must be non-empty for scope: ${ch.scopeId}`)

		otherScopes.push(scope)

		for (const op of ch.value.ops as UniverAiOpsV1[]) {
			totalOps++
			if (totalOps > maxOps) throw new Error(`[univer] ops exceed contract limit: ${totalOps} > ${maxOps}`)
			const row = (op as any).row
			const col = (op as any).col
			if (!Number.isInteger(row) || !Number.isInteger(col)) throw new Error('[univer] op row/col must be integers')
			if (!rangeContainsCell(scope.range, row, col)) throw new Error(`[univer] op out of scope range: ${scope.id}`)
			const cellKey = `${scope.sheetId}:${row}:${col}`
			if (editedCells.has(cellKey)) throw new Error(`[univer] same cell edited in multiple ops: ${cellKey}`)
			editedCells.add(cellKey)
		}
	}

	for (const clear of clearScopes) {
		for (const other of otherScopes) {
			if (clear.sheetId !== other.sheetId) continue
			if (rangesOverlap(clear.range, other.range)) {
				throw new Error(`[univer] clear scope overlaps another change scope (${clear.id} vs ${other.id})`)
			}
		}
	}
}

