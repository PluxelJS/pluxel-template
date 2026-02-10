import type { Meta, StoryObj } from '@storybook/react'
import { Button, Space, Tag, Typography } from '@douyinfe/semi-ui-19'
import { IconSparkles } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { UniverLoopbackRunInput, UniverLoopbackRunResult } from '@pluxel/univer-protocol'

import { AiPanel } from './ai-panel'
import { AiFloatWindow } from './ai-float-window'
import type { LoopbackBackend } from './loopback-backend'
import { createUniverRuntime, type UniverRuntime } from '../univer/runtime'

const meta: Meta<typeof AiPanel> = {
	title: 'Univer/AI Panel',
	component: AiPanel,
	parameters: { layout: 'fullscreen' },
}

export default meta
type Story = StoryObj<typeof AiPanel>

function toStringMatrix(input: unknown) {
	if (!Array.isArray(input)) return []
	return input.map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? '')) : []))
}

function UniverAiPlayground() {
	const mountRef = useRef<HTMLDivElement | null>(null)
	const runtimeRef = useRef<UniverRuntime | null>(null)
	const [ready, setReady] = useState(false)
	const [runtimeSeq, setRuntimeSeq] = useState(0)
	const [aiOpen, setAiOpen] = useState(true)
	const [aiOpenSeq, setAiOpenSeq] = useState(0)
	const [rev, setRev] = useState(1)

	const openAiPanel = useCallback(() => {
		setAiOpen(true)
		setAiOpenSeq((v) => v + 1)
	}, [])

	const selectDemoRange = useCallback(() => {
		const rt = runtimeRef.current
		if (!rt) return
		const workbook = rt.api.getActiveWorkbook()
		const sheet = workbook?.getActiveSheet()
		if (!sheet) return
		try {
			sheet.setActiveSelection(
				sheet.getRange({
					startRow: 0,
					startColumn: 0,
					endRow: 4,
					endColumn: 4,
				}),
			)
		} catch {}
	}, [])

	const seedWorkbook = useCallback((rt: UniverRuntime) => {
		const workbook = rt.api.getActiveWorkbook()
		const sheet = workbook?.getActiveSheet()
		if (!sheet) return
		sheet
			.getRange({ startRow: 0, startColumn: 0, endRow: 6, endColumn: 4 })
			.setValues([
				['产品', '数量', '价格', '币种', '负责人'],
				['A', '12', '9.99', 'USD', 'Luna'],
				['B', '', '12.5', 'USD', 'Tom'],
				['C', '3', '', 'CNY', ''],
				['D', '1', '99', 'JPY', 'Alice'],
				['', '', '', '', ''],
				['提示：选中一片区域，然后在右侧对话中发送“补全并规范化”。', '', '', '', ''],
			])
	}, [])

	useEffect(() => {
		if (!mountRef.current) return
		const rt = createUniverRuntime({
			mountEl: mountRef.current,
			workbookId: 'demo-workbook',
			workbookName: 'Storybook',
			installedPlugins: [],
			aiEntryEnabled: true,
			onAiOpen: openAiPanel,
		})
		runtimeRef.current = rt
		setRuntimeSeq((v) => v + 1)
		;(window as any).__univerStoryRuntime = rt
		seedWorkbook(rt)
		selectDemoRange()
		setReady(true)
		return () => {
			rt.dispose()
			runtimeRef.current = null
			setRuntimeSeq((v) => v + 1)
			;(window as any).__univerStoryRuntime = null
			setReady(false)
		}
	}, [openAiPanel, seedWorkbook, selectDemoRange])

	const backend = useMemo<LoopbackBackend>(() => {
		return {
			runLoopback: async (input: UniverLoopbackRunInput): Promise<UniverLoopbackRunResult> => {
				await new Promise((r) => setTimeout(r, 380))

				const rt = runtimeRef.current
				const workbook = rt?.api.getActiveWorkbook()
				const sheet = workbook?.getActiveSheet()
				if (!rt || !workbook || !sheet) return { ok: false, error: 'runtime not ready' }

				const range = sheet.getRange(input.current ?? input.read?.[0] ?? 'A1')
				const source = toStringMatrix(range.getDisplayValues())
				const next = source.map((row, r) =>
					row.map((cell, c) => {
						const v = String(cell ?? '')
						if (String(input.instruction ?? '').includes('补全') && v.trim() === '') return '—'
						if (r === 0) return v.trim().toUpperCase()
						if (c === 0 && v.trim() !== '') return `#${v.trim()}`
						return v
					}),
				)

				range.setValues(next as any)

				let appliedOps = 0
				for (let r = 0; r < next.length; r++) {
					for (let c = 0; c < (next[r]?.length ?? 0); c++) {
						if (String(next[r]?.[c] ?? '') !== String(source[r]?.[c] ?? '')) appliedOps++
					}
				}

				const baseRev = rev
				const newRev = baseRev + 1
				setRev(newRev)
				return {
					ok: true,
					baseRev,
					newRev,
					newSnapshotUrl: `mock://snapshot/${newRev}`,
					newEtag: `mock-etag-${newRev}`,
					rounds: 1,
					appliedOps,
					summary: 'Storybook mock loopback applied to the active range.',
				}
			},
		}
	}, [rev])

	const getRuntime = useCallback(() => runtimeRef.current, [])

	return (
		<div className="univer-standalone">
			<div className="univer-standalone__header">
				<div className="univer-standalone__header-top">
					<div>
						<Typography.Text strong>Univer × AI（mock backend）</Typography.Text>
						<div className="univer-standalone__meta">
							<Space spacing="tight" wrap>
								<Tag color="blue" size="small">
									真实 Univer
								</Tag>
								<Tag color="green" size="small">
									可编辑
								</Tag>
								<Tag color="grey" size="small">
									Mock Loopback
								</Tag>
							</Space>
							<div style={{ marginTop: 6 }}>
								<Typography.Text type="tertiary">
									在表格里选择一个区域 → 点击 “Open AI” → 发送「补全并规范化」→ 模拟后端 loopback：直接提交修改并刷新编辑器快照（Storybook 里用 mock 实现）。
								</Typography.Text>
							</div>
						</div>
					</div>
					<div className="univer-standalone__actions">
						<Button size="small" onClick={selectDemoRange}>
							Select A1:E5
						</Button>
						<Button size="small" type="primary" icon={<IconSparkles size={16} />} onClick={openAiPanel}>
							Open AI
						</Button>
					</div>
				</div>
			</div>

			<div className="univer-standalone__body">
				<div ref={mountRef} className="univer-standalone__mount" />
			</div>

			<AiFloatWindow open={aiOpen} openSeq={aiOpenSeq} onOpenChange={setAiOpen} title="AI">
				<AiPanel ready={ready} workbookId="demo-workbook" getRuntime={getRuntime} runtimeSeq={runtimeSeq} backend={backend} dirty={false} />
			</AiFloatWindow>
		</div>
	)
}

export const Playground: Story = {
	render: () => <UniverAiPlayground />,
}
