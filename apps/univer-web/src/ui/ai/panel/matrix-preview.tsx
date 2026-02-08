import type { ReactNode } from 'react'

function clampMatrix(matrix: string[][], maxRows = 6, maxCols = 6) {
	const rows = matrix.slice(0, maxRows)
	const trimmed = rows.map((row) => (Array.isArray(row) ? row.slice(0, maxCols) : []))
	const overflowRows = matrix.length > maxRows
	const overflowCols = matrix.some((row) => (row?.length ?? 0) > maxCols)
	return { trimmed, overflowRows, overflowCols }
}

export function MatrixPreview(props: { matrix: string[][] | null; maxRows?: number; maxCols?: number }): ReactNode {
	if (!props.matrix) {
		return <div className="univer-ai-matrix__empty">清空</div>
	}
	const maxRows = props.maxRows ?? 6
	const maxCols = props.maxCols ?? 6
	const { trimmed, overflowCols, overflowRows } = clampMatrix(props.matrix, maxRows, maxCols)
	return (
		<div className="univer-ai-matrix">
			<table>
				<tbody>
					{trimmed.map((row, r) => (
						<tr key={r}>
							{row.map((cell, c) => (
								<td key={c}>{cell === '' ? '∅' : cell}</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
			{overflowRows || overflowCols ? (
				<div className="univer-ai-matrix__meta">
					{overflowRows ? '…更多行' : null}
					{overflowRows && overflowCols ? ' · ' : null}
					{overflowCols ? '…更多列' : null}
				</div>
			) : null}
		</div>
	)
}

