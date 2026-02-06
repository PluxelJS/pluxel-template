import { Alert, Badge, Button, Checkbox, Code, Divider, Group, Loader, ScrollArea, Stack, Table, Text, Textarea, Title } from '@mantine/core'
import { IconBolt, IconCheck, IconEye, IconSparkles, IconX } from '@tabler/icons-react'
import { rpcErrorMessage } from '@pluxel/hmr/web'
import { useCallback, useMemo, useState } from 'react'

import type { UniverAiChange, UniverAiChangeSet, UniverAiSuggestEditsInput } from 'pluxel-plugin-univer-ai'
import type { UniverRuntime } from '../univer/runtime'

type AiPanelProps = {
	ready: boolean
	workbookId: string
	getRuntime(): UniverRuntime | null
	rpc: { suggestEdits(input: UniverAiSuggestEditsInput): Promise<{ changeSet: UniverAiChangeSet }> } | null
}

function rangeRowsCols(range: UniverAiChange['range']) {
	return { rows: range.endRow - range.startRow + 1, cols: range.endCol - range.startCol + 1 }
}

function as2dArray(value: unknown): unknown[][] | null {
	if (!Array.isArray(value)) return null
	if (!value.every(Array.isArray)) return null
	return value as unknown[][]
}

export function AiPanel({ ready, workbookId, getRuntime, rpc }: AiPanelProps) {
	const [instruction, setInstruction] = useState('把选区里的数据整理成一张干净的表，并补全缺失字段。')
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [warn, setWarn] = useState<string | null>(null)
	const [changeSet, setChangeSet] = useState<UniverAiChangeSet | null>(null)
	const [selected, setSelected] = useState<Record<string, boolean>>({})
	const [activeChangeId, setActiveChangeId] = useState<string | null>(null)
	const [preview, setPreview] = useState<Record<string, { old: string[][]; next: string[][] | null }>>({})

	const selectedIds = useMemo(() => Object.entries(selected).filter(([, v]) => v).map(([id]) => id), [selected])

	const ensureRpc = useCallback(() => {
		if (!rpc) {
			setError('UniverAI RPC 未启用：请在 `pluxel.hmr.jsonc` profile 中启用 `pluxel-plugin-univer-ai`。')
			return null
		}
		return rpc
	}, [rpc])

	const collectContext = useCallback(() => {
		const rt = getRuntime()
		if (!rt) return null
		const fWorkbook = rt.api.getActiveWorkbook()
		if (!fWorkbook) return null
		const fWorksheet = fWorkbook.getActiveSheet()
		if (!fWorksheet) return null

		const active = fWorkbook.getActiveRange() ?? fWorksheet.getActiveRange()
		if (!active) return null

		const range = active.getRange()
		const sheetId = fWorksheet.getSheetId()
		const a1 = active.getA1Notation(true)

		const maxRows = 40
		const maxCols = 16
		const origRows = range.endRow - range.startRow + 1
		const origCols = range.endColumn - range.startColumn + 1

		const endRow = Math.min(range.endRow, range.startRow + maxRows - 1)
		const endCol = Math.min(range.endColumn, range.startColumn + maxCols - 1)
		const sliceRange = {
			startRow: range.startRow,
			startCol: range.startColumn,
			endRow,
			endCol,
		}

		const fRange = fWorksheet.getRange({
			startRow: sliceRange.startRow,
			startColumn: sliceRange.startCol,
			endRow: sliceRange.endRow,
			endColumn: sliceRange.endCol,
		})

		const displayValues = fRange.getDisplayValues()
		return {
			workbookId,
			sheetId,
			range: sliceRange,
			a1,
			displayValues,
			meta: {
				truncated: origRows > maxRows || origCols > maxCols,
				orig: { startRow: range.startRow, startCol: range.startColumn, endRow: range.endRow, endCol: range.endColumn, rows: origRows, cols: origCols },
				limits: { maxRows, maxCols },
			},
		}
	}, [getRuntime, workbookId])

	const suggest = useCallback(async () => {
		setError(null)
		setWarn(null)
		const rpc = ensureRpc()
		if (!rpc) return
		if (!ready) return
		const ctx = collectContext()
		if (!ctx) {
			setError('无法获取选区：请先在表格里选中一个区域。')
			return
		}

		setLoading(true)
		try {
			const input: UniverAiSuggestEditsInput = {
				workbookId,
				instruction: instruction.trim(),
				context: { format: 'json', contentType: 'application/json; charset=utf-8', text: JSON.stringify(ctx) },
				mode: 'safe',
				contextHint: { sheetId: ctx.sheetId, range: ctx.range, a1: ctx.a1 },
			}
			const res = await rpc.suggestEdits(input)
			setChangeSet(res.changeSet)
			const initSel: Record<string, boolean> = {}
			for (const c of res.changeSet.changes) initSel[c.id] = true
			setSelected(initSel)
			setActiveChangeId(res.changeSet.changes[0]?.id ?? null)
			setPreview({})
		} catch (err) {
			setChangeSet(null)
			setError(rpcErrorMessage(err, 'AI 生成失败'))
		} finally {
			setLoading(false)
		}
	}, [collectContext, ensureRpc, instruction, ready, workbookId])

	const focusChange = useCallback(
		(change: UniverAiChange) => {
			const rt = getRuntime()
			if (!rt) return
			setActiveChangeId(change.id)
			rt.highlightRange({
				sheetId: change.sheetId ?? null,
				range: change.range,
				style: { stroke: '#a855f7', fill: 'rgba(168, 85, 247, 0.12)' },
			})

			setPreview((prev) => {
				if (prev[change.id]) return prev
				const fWorkbook = rt.api.getActiveWorkbook()
				const fWorksheet = change.sheetId ? fWorkbook?.getSheetBySheetId(change.sheetId) : fWorkbook?.getActiveSheet()
				if (!fWorkbook || !fWorksheet) return prev
				const fRange = fWorksheet.getRange({
					startRow: change.range.startRow,
					startColumn: change.range.startCol,
					endRow: change.range.endRow,
					endColumn: change.range.endCol,
				})
				const old = fRange.getDisplayValues()
				const next = change.op === 'setValues' ? as2dArray(change.value)?.map((r) => r.map((v) => (v == null ? '' : String(v)))) ?? null : null
				return { ...prev, [change.id]: { old, next } }
			})
		},
		[getRuntime],
	)

	const toggleSelected = useCallback((id: string) => {
		setSelected((prev) => ({ ...prev, [id]: !prev[id] }))
	}, [])

	const selectAll = useCallback(() => {
		if (!changeSet) return
		const next: Record<string, boolean> = {}
		for (const c of changeSet.changes) next[c.id] = true
		setSelected(next)
	}, [changeSet])

	const clearAll = useCallback(() => {
		if (!changeSet) return
		const next: Record<string, boolean> = {}
		for (const c of changeSet.changes) next[c.id] = false
		setSelected(next)
	}, [changeSet])

	const applySelected = useCallback(async () => {
		setError(null)
		setWarn(null)
		if (!ready) return
		const rt = getRuntime()
		if (!rt) return
		const fWorkbook = rt.api.getActiveWorkbook()
		if (!fWorkbook) return
		if (!changeSet) return

		const ids = new Set(selectedIds)
		if (ids.size === 0) return

		setLoading(true)
		try {
			const conflicts: string[] = []
			const invalid: string[] = []
			await rt.withUndoBatch(async () => {
				await (fWorkbook as any).abortEditingAsync?.()

				for (const c of changeSet.changes) {
					if (!ids.has(c.id)) continue
					const fWorksheet = c.sheetId ? fWorkbook.getSheetBySheetId(c.sheetId) : fWorkbook.getActiveSheet()
					if (!fWorksheet) continue

					if (c.sheetId) fWorkbook.setActiveSheet(c.sheetId)

					const fRange = fWorksheet.getRange({
						startRow: c.range.startRow,
						startColumn: c.range.startCol,
						endRow: c.range.endRow,
						endColumn: c.range.endCol,
					})

					if (c.expectedOld !== undefined) {
						const cur = fRange.getValues()
						const expected = c.expectedOld
						const ok = JSON.stringify(cur) === JSON.stringify(expected) || (JSON.stringify(cur) === JSON.stringify([[expected]]))
						if (!ok) {
							conflicts.push(c.id)
							continue
						}
					}

					if (c.op === 'clear') {
						fRange.clearContent()
						continue
					}

					const matrix = as2dArray(c.value)
					if (!matrix) {
						invalid.push(c.id)
						continue
					}
					const { rows, cols } = rangeRowsCols(c.range)
					if (matrix.length !== rows || matrix.some((r) => r.length !== cols)) {
						invalid.push(c.id)
						continue
					}

					fRange.setValues(matrix as any)
				}
			})

			if (conflicts.length || invalid.length) {
				setWarn(`部分变更未应用：conflicts=${conflicts.length} invalid=${invalid.length}`)
			}
		} catch (err) {
			setError(rpcErrorMessage(err, '应用变更失败'))
		} finally {
			setLoading(false)
		}
	}, [changeSet, getRuntime, ready, selectedIds])

	return (
		<Stack gap="sm" style={{ height: '100%' }}>
			<Group justify="space-between" wrap="nowrap">
				<Group gap="xs" wrap="nowrap">
					<IconSparkles size={18} />
					<Title order={5}>AI</Title>
					<Badge variant="light">ChangeSet</Badge>
				</Group>
				{loading ? <Loader size="sm" /> : null}
			</Group>

			{rpc ? null : (
				<Alert color="yellow" title="未启用 UniverAI">
					<Text size="sm">
						请在 `pluxel.hmr.jsonc` 中启用 <Code>pluxel-plugin-univer-ai</Code>，并确保 <Code>pluxel-plugin-llm-hub</Code> 已配置默认 profile。
					</Text>
				</Alert>
			)}

			{error ? (
				<Alert color="red" title="错误">
					{error}
				</Alert>
			) : null}

			{warn ? (
				<Alert color="yellow" title="提示">
					{warn}
				</Alert>
			) : null}

			<Textarea
				label="指令"
				autosize
				minRows={3}
				value={instruction}
				onChange={(e) => setInstruction(e.currentTarget.value)}
				disabled={!ready || loading}
			/>

			<Group justify="space-between">
				<Button leftSection={<IconBolt size={16} />} onClick={() => void suggest()} disabled={!ready || loading || !rpc}>
					生成建议
				</Button>
				<Group gap="xs">
					<Button variant="subtle" leftSection={<IconCheck size={16} />} onClick={selectAll} disabled={!changeSet || loading}>
						全选
					</Button>
					<Button variant="subtle" leftSection={<IconX size={16} />} onClick={clearAll} disabled={!changeSet || loading}>
						全不选
					</Button>
				</Group>
			</Group>

			{changeSet ? (
				<>
					<Divider />
					<Stack gap={6}>
						<Group justify="space-between" wrap="nowrap">
							<Text size="sm" fw={600}>
								建议摘要
							</Text>
							<Text size="xs" c="dimmed">
								changes: <Code>{changeSet.changes.length}</Code> · selected: <Code>{selectedIds.length}</Code>
							</Text>
						</Group>
						{changeSet.summary ? (
							<Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
								{changeSet.summary}
							</Text>
						) : (
							<Text size="sm" c="dimmed">
								（无 summary）
							</Text>
						)}
					</Stack>

					<Group justify="space-between" mt="sm">
						<Button
							variant="light"
							leftSection={<IconCheck size={16} />}
							onClick={() => void applySelected()}
							disabled={!ready || loading || selectedIds.length === 0}
						>
							应用所选
						</Button>
					</Group>

					<Divider my="sm" />

					<ScrollArea style={{ flex: 1 }}>
						<Table highlightOnHover>
							<Table.Thead>
								<Table.Tr>
									<Table.Th style={{ width: 42 }} />
									<Table.Th>Op</Table.Th>
									<Table.Th>Range</Table.Th>
									<Table.Th>Reason</Table.Th>
								</Table.Tr>
							</Table.Thead>
							<Table.Tbody>
								{changeSet.changes.map((c) => (
									<Table.Tr
										key={c.id}
										style={{
											cursor: 'pointer',
											background: activeChangeId === c.id ? 'rgba(168, 85, 247, 0.10)' : undefined,
										}}
										onClick={() => focusChange(c)}
									>
										<Table.Td>
											<Checkbox checked={!!selected[c.id]} onChange={() => toggleSelected(c.id)} onClick={(e) => e.stopPropagation()} />
										</Table.Td>
										<Table.Td>
											<Text size="sm">
												<Code>{c.op}</Code>
											</Text>
										</Table.Td>
										<Table.Td>
											<Text size="sm">
												r{c.range.startRow}:c{c.range.startCol} → r{c.range.endRow}:c{c.range.endCol}
											</Text>
										</Table.Td>
										<Table.Td>
											<Text size="sm" c={c.reason ? undefined : 'dimmed'} lineClamp={2}>
												{c.reason ?? '—'}
											</Text>
										</Table.Td>
									</Table.Tr>
								))}
							</Table.Tbody>
						</Table>

						{activeChangeId && preview[activeChangeId] ? (
							<Stack gap={6} mt="sm">
								<Group gap="xs">
									<IconEye size={16} />
									<Text size="sm" fw={600}>
										预览（best-effort）
									</Text>
								</Group>
								<Text size="xs" c="dimmed">
									Old（display）:
								</Text>
								<Code block>{JSON.stringify(preview[activeChangeId]!.old)}</Code>
								<Text size="xs" c="dimmed">
									New（stringified）:
								</Text>
								<Code block>{JSON.stringify(preview[activeChangeId]!.next)}</Code>
							</Stack>
						) : null}
					</ScrollArea>
				</>
			) : (
				<Text size="sm" c="dimmed">
					生成建议后，这里会展示 ChangeSet 列表（可勾选、定位高亮、批量应用）。
				</Text>
			)}
		</Stack>
	)
}
