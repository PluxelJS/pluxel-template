import type { Meta, StoryObj } from '@storybook/react'
import { Button, Space, Tag, Typography } from '@douyinfe/semi-ui-19'
import { IconSparkles } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { UniverAiChange, UniverAiContext, UniverAiSuggestEditsMeta } from 'pluxel-plugin-univer-ai'

import { AiPanel } from './ai-panel'
import { AiFloatWindow } from './ai-float-window'
import type { UniverAiFrontendApi, UniverAiSuggestInput } from './ai-contract'
import { createUniverRuntime, type UniverRuntime } from '../univer/runtime'

const meta: Meta<typeof AiPanel> = {
	title: 'Univer/AI Panel',
	component: AiPanel,
	parameters: { layout: 'fullscreen' },
}

export default meta
type Story = StoryObj<typeof AiPanel>

const demoMeta: UniverAiSuggestEditsMeta = {
	llmProfile: { id: 'demo', provider: 'mock', model: 'storybook' },
}

function toStringMatrix(input: unknown) {
	if (!Array.isArray(input)) return []
	return input.map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? '')) : []))
}

function buildMockChangeSet(ctx: UniverAiContext, instruction: string) {
	if (!ctx.range) throw new Error('[storybook] missing ctx.range')
	const source = toStringMatrix(ctx.displayValues)
	const next = source.map((row, r) =>
		row.map((cell, c) => {
			const v = String(cell ?? '')
			if (instruction.toLowerCase().includes('补全') && v.trim() === '') return '—'
			if (r === 0) return v.trim().toUpperCase()
			if (c === 0 && v.trim() !== '') return `#${v.trim()}`
			return v
		}),
	)

	const changes: UniverAiChange[] = [
		{
			id: `change-${Date.now()}`,
			op: 'setValues',
			range: ctx.range,
			value: next,
			reason: '字段规范化 + 补齐缺失值（mock）',
		},
	]

	// Add a second tiny change so hover popup is easy to see.
	changes.push({
		id: `change-note-${Date.now()}`,
		op: 'setValues',
		range: { startRow: 1, startCol: 4, endRow: 1, endCol: 4 },
		value: [['AI']],
		reason: '标记负责人为 AI（mock）',
	})

	return {
		changeSet: {
			id: `cs-${Date.now()}`,
			workbookId: ctx.workbookId,
			createdAt: Date.now(),
			summary: 'Storybook mock：生成两个变更，便于体验 Preview/Apply + hover old/new。',
			changes,
		},
		meta: demoMeta,
	}
}

function UniverAiPlayground() {
	const mountRef = useRef<HTMLDivElement | null>(null)
	const runtimeRef = useRef<UniverRuntime | null>(null)
	const [ready, setReady] = useState(false)
	const [runtimeSeq, setRuntimeSeq] = useState(0)
	const [aiOpen, setAiOpen] = useState(true)
	const [aiOpenSeq, setAiOpenSeq] = useState(0)

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

	const api = useMemo<UniverAiFrontendApi>(
		() => ({
			suggestEdits: async (input: UniverAiSuggestInput) => {
				await new Promise((r) => setTimeout(r, 450))
				const rt = runtimeRef.current
				if (!rt) return { changeSet: null, meta: demoMeta }
				const workbook = rt.api.getActiveWorkbook()
				const sheet = input.contextHint.sheetId
					? workbook?.getSheetBySheetId(input.contextHint.sheetId)
					: workbook?.getActiveSheet()
				if (!workbook || !sheet) return { changeSet: null, meta: demoMeta }

				const range = input.contextHint.range
				const displayValues = sheet
					.getRange({
						startRow: range.startRow,
						startColumn: range.startCol,
						endRow: range.endRow,
						endColumn: range.endCol,
					})
					.getDisplayValues()
				const ctx: UniverAiContext = {
					workbookId: input.workbookId,
					sheetId: sheet.getSheetId(),
					range,
					a1: input.contextHint.a1 ?? '',
					displayValues,
					meta: { truncated: false },
				}
				return buildMockChangeSet(ctx, input.instruction)
			},
		}),
		[],
	)

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
									Mock LLM
								</Tag>
							</Space>
							<div style={{ marginTop: 6 }}>
								<Typography.Text type="tertiary">
									在表格里拖拽选择一个区域（支持 Ctrl 多选）→ 点击 “Open AI”（或右键/工具栏 AI）→ 发送「补全并规范化」→ 在「变更」里 Preview / Apply（橙色=预览值；悬浮单元格可看原值/新值并 Apply/Undo/Ignore）。
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
				<AiPanel ready={ready} workbookId="demo-workbook" getRuntime={getRuntime} runtimeSeq={runtimeSeq} api={api} />
			</AiFloatWindow>
		</div>
	)
}

export const Playground: Story = {
	render: () => <UniverAiPlayground />,
}
