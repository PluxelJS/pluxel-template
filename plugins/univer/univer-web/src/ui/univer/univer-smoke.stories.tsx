import type { Meta, StoryObj } from '@storybook/react'
import { Button, Space, Tag, Typography } from '@douyinfe/semi-ui-19'
import { IconFocus } from '@tabler/icons-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { IUniverInstanceService, UniverInstanceType } from '@univerjs/core'
import { ILayoutService } from '@univerjs/ui'

import { createUniverRuntime, type UniverRuntime } from './runtime'

const meta: Meta = {
	title: 'Univer/Smoke',
	parameters: { layout: 'fullscreen' },
}

export default meta
type Story = StoryObj

function pickActiveElementSummary() {
	const el = document.activeElement as HTMLElement | null
	if (!el) return '(none)'
	const name = el.tagName.toLowerCase()
	const uComp = el.dataset?.uComp ? ` data-u-comp=${JSON.stringify(el.dataset.uComp)}` : ''
	const id = el.id ? `#${el.id}` : ''
	const cls = el.className && typeof el.className === 'string' ? `.${el.className.split(/\s+/).filter(Boolean).slice(0, 3).join('.')}` : ''
	return `${name}${id}${cls}${uComp}`
}

function UniverSmokeStory() {
	const mountRef = useRef<HTMLDivElement | null>(null)
	const runtimeRef = useRef<UniverRuntime | null>(null)
	const [ready, setReady] = useState(false)
	const [debugText, setDebugText] = useState<string | null>(null)

	const seedWorkbook = useCallback((rt: UniverRuntime) => {
		const workbook = rt.api.getActiveWorkbook()
		const sheet = workbook?.getActiveSheet()
		if (!sheet) return
		sheet
			.getRange({ startRow: 0, startColumn: 0, endRow: 6, endColumn: 4 })
			.setValues([
				['Try editing:', 'click a cell', 'type', '(or press F2)'],
				['A', '12', '9.99', 'USD'],
				['B', '', '12.5', 'USD'],
				['C', '3', '', 'CNY'],
				['D', '1', '99', 'JPY'],
				['', '', '', ''],
				['Note: Ctrl+C/V should also work.', '', '', ''],
			])
	}, [])

	useEffect(() => {
		if (!mountRef.current) return
		const rt = createUniverRuntime({
			mountEl: mountRef.current,
			workbookId: 'smoke-workbook',
			workbookName: 'Smoke',
			installedPlugins: [],
		})
		runtimeRef.current = rt
		;(window as any).__univerSmokeRuntime = rt
		seedWorkbook(rt)
		setReady(true)
		return () => {
			rt.dispose()
			runtimeRef.current = null
			;(window as any).__univerSmokeRuntime = null
			setReady(false)
		}
	}, [seedWorkbook])

	const forceFocus = useCallback(() => {
		const rt = runtimeRef.current
		if (!rt) return
		const injector = rt.univer.__getInjector()
		const layout = injector.get(ILayoutService)
		layout.focus()
		const root = layout.rootContainerElement ?? mountRef.current
		const canvas =
			(root?.querySelector('[data-u-comp="render-canvas"]') as HTMLElement | null) ??
			(root?.querySelector('[data-range-selector]') as HTMLElement | null) ??
			null
		if (canvas) {
			if (canvas.tabIndex < 0) canvas.tabIndex = 0
			canvas.focus({ preventScroll: true })
		}
	}, [])

	const dumpDebug = useCallback(() => {
		const rt = runtimeRef.current
		if (!rt) return
		const injector = rt.univer.__getInjector()
		const layout = injector.get(ILayoutService)
		const instance = injector.get(IUniverInstanceService)
		const focusedUnit = instance.getFocusedUnit()
		const currentSheet = instance.getCurrentUnitOfType(UniverInstanceType.UNIVER_SHEET)
		const workbook = rt.api.getWorkbook(rt.workbookId)
		const canEdit = workbook?.getWorkbookPermission().canEdit()
		const editorCount = document.querySelectorAll('[data-u-comp="editor"]').length
		const canvasCount = document.querySelectorAll('[data-u-comp="render-canvas"]').length
		setDebugText(
			JSON.stringify(
				{
					activeElement: pickActiveElementSummary(),
					layoutFocused: String(layout.isFocused),
					contentFocused: String(layout.checkContentIsFocused()),
					focusedUnit: focusedUnit ? `${focusedUnit.type}:${focusedUnit.getUnitId()}` : '(none)',
					currentSheet: currentSheet ? currentSheet.getUnitId() : '(none)',
					canEdit: typeof canEdit === 'boolean' ? String(canEdit) : '(unknown)',
					editorCount: String(editorCount),
					canvasCount: String(canvasCount),
				},
				null,
				2,
			),
		)
	}, [])

	useEffect(() => {
		if (!ready) return
		dumpDebug()
	}, [dumpDebug, ready])

	return (
		<div className="univer-standalone">
			<div className="univer-standalone__header">
				<div className="univer-standalone__header-top">
					<div>
						<Typography.Text strong>Univer Smoke（editable）</Typography.Text>
						<div className="univer-standalone__meta">
							<Space spacing="tight" wrap>
								<Tag color="green" size="small">
									可编辑
								</Tag>
								<Tag color="grey" size="small">
									无 AI
								</Tag>
							</Space>
							<div style={{ marginTop: 6 }}>
								<Typography.Text type="tertiary">Try: click cell → type / Enter / F2 · Ctrl+C/V should work.</Typography.Text>
							</div>
						</div>
					</div>

					<div className="univer-standalone__actions">
						<Button size="small" icon={<IconFocus size={16} />} onClick={forceFocus} disabled={!ready}>
							Force Focus
						</Button>
						<Button size="small" theme="borderless" onClick={dumpDebug} disabled={!ready}>
							Debug
						</Button>
					</div>
				</div>

				{debugText ? (
					<details style={{ marginTop: 10 }}>
						<summary style={{ cursor: 'pointer' }}>
							<Typography.Text type="tertiary">Runtime debug</Typography.Text>
						</summary>
						<pre style={{ margin: '10px 0 0', maxHeight: 200, overflow: 'auto', background: '#0b1220', color: '#e2e8f0', padding: 10, borderRadius: 10 }}>
							{debugText}
						</pre>
					</details>
				) : null}
			</div>

			<div className="univer-standalone__body">
				<div ref={mountRef} className="univer-standalone__mount" />
			</div>
		</div>
	)
}

export const Basic: Story = {
	render: () => <UniverSmokeStory />,
}
