import {
	AIChatDialogue,
	AIChatInput,
	Banner,
	Button,
	Card,
	Divider,
	List,
	Space,
	Spin,
	Tabs,
	Tag,
	Typography,
} from '@douyinfe/semi-ui-19'
import { IconArrowBackUp, IconCheck, IconEye, IconPin, IconPinnedOff, IconRefresh, IconX } from '@tabler/icons-react'

import { CodeInline, Muted, SectionTitle } from '../kit'
import { useAiPanelController } from './panel/controller'
import { MatrixPreview } from './panel/matrix-preview'
import type { AiPanelProps } from './panel/types'

const chatRoleConfig = {
	user: { name: 'You' },
	assistant: { name: 'AI' },
	system: { name: 'System' },
}

export function AiPanel(props: AiPanelProps) {
	const ctrl = useAiPanelController(props)

	const connectionTag = ctrl.aiConnected ? <Tag color="green">AI 已连接</Tag> : <Tag color="grey">AI 未连接</Tag>
	const busyLabel = (() => {
		const op = ctrl.busyOp
		if (!op) return null
		switch (op.kind) {
			case 'applyAll':
				return `Applying ${op.done}/${op.total}`
			case 'undoAll':
				return `Undoing ${op.done}/${op.total}`
			case 'apply':
				return 'Applying…'
			case 'undo':
				return 'Undoing…'
			case 'reject':
				return 'Rejecting…'
			case 'preview':
				return 'Previewing…'
			case 'applySelected':
				return 'Applying selection…'
			case 'undoSelected':
				return 'Undoing selection…'
			default:
				return 'Working…'
		}
	})()

	return (
		<div className="univer-ai-panel">
			<div className="univer-ai-panel__top">
				<div className="univer-ai-panel__title">
					<SectionTitle>AI Assistant</SectionTitle>
					{connectionTag}
				</div>
				<Space spacing="tight">
					<Button
						size="small"
						theme="borderless"
						icon={ctrl.autoSync ? <IconPinnedOff size={16} /> : <IconPin size={16} />}
						onClick={() => ctrl.setAutoSync((v) => !v)}
						disabled={ctrl.busy}
					>
						{ctrl.autoSync ? '自动同步' : '冻结'}
					</Button>
					<Button
						size="small"
						theme="borderless"
						icon={<IconRefresh size={16} />}
						onClick={ctrl.refreshSelection}
						disabled={!props.ready || ctrl.busy}
					>
						刷新选区
					</Button>
				</Space>
			</div>

			{ctrl.warn ? <Banner fullMode={false} type="warning" title="提示" description={ctrl.warn} /> : null}
			{ctrl.error ? <Banner fullMode={false} type="danger" title="错误" description={ctrl.error} /> : null}

			<Card bordered={false} className="univer-ai-panel__context" bodyStyle={{ padding: 12 }}>
				<div className="univer-ai-context">
					<div className="univer-ai-context__current">
						<Typography.Text type="tertiary">当前选区</Typography.Text>
						<div className="univer-ai-context__row">
							{ctrl.currentSelection?.range ? (
								<>
									<CodeInline>{ctrl.currentSelection.a1 ?? ctrl.rangeToA1(ctrl.currentSelection.range)}</CodeInline>
									<Typography.Text type="tertiary">{ctrl.selectionLabel(ctrl.currentSelection)}</Typography.Text>
								</>
							) : (
								<Typography.Text type="tertiary">（未选中）</Typography.Text>
							)}
						</div>
					</div>
					<div className="univer-ai-context__actions">
						<Button size="small" icon={<IconPin size={16} />} onClick={ctrl.pinCurrentSelection} disabled={!props.ready}>
							固定为上下文
						</Button>
						<Button size="small" theme="borderless" disabled={!ctrl.pinnedSelections.length} onClick={ctrl.clearPins}>
							清空上下文
						</Button>
					</div>
				</div>

				{ctrl.pinnedSelections.length ? (
					<div className="univer-ai-pins">
						{ctrl.pinnedSelections.map((ctx) => {
							const id = ctrl.selectionKey(ctx)
							return (
								<div key={id} className="univer-ai-pin">
									<div className="univer-ai-pin__text">
										<Typography.Text strong>{ctrl.selectionLabel(ctx)}</Typography.Text>
										<Typography.Text type="tertiary">{ctrl.selectionMeta(ctx)}</Typography.Text>
									</div>
									<Button theme="borderless" size="small" icon={<IconX size={14} />} onClick={() => ctrl.unpinSelection(id)} />
								</div>
							)
						})}
					</div>
				) : (
					<Muted>（未固定额外上下文。可固定多个选区，用于跨片段对比/汇总。）</Muted>
				)}
			</Card>

			<Divider margin="12px 0" />

			<Tabs type="line" activeKey={ctrl.tab} onChange={(key) => ctrl.setTab(key as any)}>
				<Tabs.TabPane tab="对话" itemKey="chat">
					<div className="univer-ai-chat">
						<AIChatDialogue
							chats={ctrl.chats}
							align="leftAlign"
							mode="bubble"
							roleConfig={chatRoleConfig}
							className="univer-ai-chat__dialogue"
						/>
						<AIChatInput
							placeholder="在表格里选区后，描述你希望 AI 完成的修改…"
							keepSkillAfterSend={false}
							onMessageSend={ctrl.handleAiSend}
							canSend={ctrl.aiConnected && !ctrl.busy}
							generating={ctrl.loading}
							references={ctrl.selectionReferences}
							showReference={ctrl.selectionReferences.length > 0}
							onReferenceDelete={(ref) => {
								if ((ref as any).closable === false) return
								ctrl.unpinSelection(ref.id)
							}}
							renderReference={(ref) => (
								<div key={ref.id} className="univer-ai-ref" data-closable={(ref as any).closable !== false ? 'true' : 'false'}>
									<div className="univer-ai-ref__text">
										<Typography.Text strong>{(ref as any).label ?? ref.id}</Typography.Text>
										{(ref as any).meta ? <Typography.Text type="tertiary">{(ref as any).meta}</Typography.Text> : null}
									</div>
									{(ref as any).closable !== false ? (
										<Button theme="borderless" size="small" icon={<IconX size={12} />} onClick={() => ctrl.unpinSelection(ref.id)} />
									) : null}
								</div>
							)}
							showUploadButton={false}
							showUploadFile={false}
							sendHotKey="enter"
							className="univer-ai-chat__input"
						/>
						<div className="univer-ai-chat__footer">
							<Space spacing="tight">
								<Typography.Text type="tertiary">
									上下文格式：<CodeInline>TOON</CodeInline>
								</Typography.Text>
								{ctrl.pinnedSelections.length ? (
									<Typography.Text type="tertiary">· 已固定 {ctrl.pinnedSelections.length} 个片段</Typography.Text>
								) : null}
							</Space>
						</div>
					</div>
				</Tabs.TabPane>

				<Tabs.TabPane tab="变更" itemKey="changes">
					<div className="univer-ai-changes">
						<div className="univer-ai-changes__top">
							<Space spacing="tight" wrap>
								<Tag color="blue">Preview: 橙色</Tag>
								<Tag color="green">Applied: 绿色</Tag>
								<Tag color="grey">Rejected: 灰色</Tag>
								{busyLabel ? <Tag color="orange">{busyLabel}</Tag> : null}
							</Space>
							<Space spacing="tight">
								<Button
									size="small"
									icon={<IconEye size={16} />}
									onClick={() => ctrl.setPreviewMode((v) => (v === 'overlay' ? 'inSheet' : 'overlay'))}
									disabled={ctrl.busy}
								>
									预览模式：{ctrl.previewMode === 'overlay' ? '虚拟渲染' : '写入表格'}
								</Button>
								{ctrl.previewMode === 'overlay' ? (
									<Button
										size="small"
										theme="borderless"
										onClick={() => ctrl.setVirtualRender((v) => !v)}
										disabled={ctrl.busy}
									>
										预览值：{ctrl.virtualRender ? '开' : '关'}
									</Button>
								) : null}
								<Button size="small" theme="borderless" onClick={() => ctrl.setHoverPopup((v) => !v)} disabled={ctrl.busy}>
									悬浮提示：{ctrl.hoverPopup ? '开' : '关'}
								</Button>
							</Space>
						</div>

						{ctrl.preparedChanges.length ? (
							<Space spacing="tight" style={{ margin: '8px 0 0' }}>
								<Button size="small" type="primary" icon={<IconCheck size={16} />} onClick={() => void ctrl.applyAll()} disabled={ctrl.busy}>
									全部应用
								</Button>
								<Button size="small" icon={<IconArrowBackUp size={16} />} onClick={() => void ctrl.undoAll()} disabled={ctrl.busy}>
									全部撤销
								</Button>
							</Space>
						) : null}

						<div className="univer-ai-changes__body" data-empty={ctrl.preparedChanges.length ? 'false' : 'true'}>
							{ctrl.loading ? (
								<div className="univer-ai-center">
									<Spin />
								</div>
							) : ctrl.preparedChanges.length ? (
								<div className="univer-ai-changes__grid">
									<div className="univer-ai-changes__list">
										<List
											dataSource={ctrl.preparedChanges}
											renderItem={(ch) => {
												const state = ctrl.changeState[ch.id] ?? 'idle'
												const isActive = ch.id === ctrl.activeChangeId
												const stateColor =
													state === 'applied'
														? 'green'
														: state === 'preview'
															? 'orange'
															: state === 'rejected'
																? 'grey'
																: 'blue'
												const stateLabel = state === 'idle' ? 'SUGGESTED' : state.toUpperCase()
												const visibleDiffs = ctrl.visibleDiffCountByChange?.[ch.id] ?? ch.cellDiffs.length
												const busyOp = ctrl.busyOp
												return (
													<List.Item
														main
														className="univer-ai-change"
														data-active={isActive ? 'true' : 'false'}
														onClick={() => ctrl.setActiveChangeId(ch.id)}
													>
														<div className="univer-ai-change__title">
															<Typography.Text strong>{ctrl.rangeToA1(ch.range)}</Typography.Text>
															<Tag size="small" color={stateColor}>
																{stateLabel}
															</Tag>
														</div>
														<Typography.Text type="tertiary">{ch.reason ?? ch.op}</Typography.Text>
														<div className="univer-ai-change__meta">
															<Tag size="small" color="light-blue">
																Δ {visibleDiffs}
															</Tag>
															{ch.sheetId ? (
																<Tag size="small" color="light-blue">
																	{ch.sheetId}
																</Tag>
															) : null}
														</div>
														<div className="univer-ai-change__actions">
															<Button
																size="small"
																onClick={() => void ctrl.previewChange(ch.id)}
																disabled={!props.ready || ctrl.busy || state === 'rejected'}
																loading={busyOp?.kind === 'preview' && busyOp.changeId === ch.id}
															>
																Preview
															</Button>
															<Button
																size="small"
																type="primary"
																onClick={() => void ctrl.applyChange(ch.id)}
																disabled={!props.ready || ctrl.busy || state === 'rejected'}
																loading={busyOp?.kind === 'apply' && busyOp.changeId === ch.id}
															>
																Apply
															</Button>
															<Button
																size="small"
																onClick={() => void ctrl.undoChange(ch.id)}
																disabled={!props.ready || ctrl.busy || state === 'idle' || state === 'rejected'}
																loading={busyOp?.kind === 'undo' && busyOp.changeId === ch.id}
															>
																Undo
															</Button>
															<Button
																size="small"
																theme="borderless"
																onClick={() => void ctrl.rejectChange(ch.id)}
																disabled={!props.ready || ctrl.busy || state === 'rejected'}
																loading={busyOp?.kind === 'reject' && busyOp.changeId === ch.id}
															>
																Reject
															</Button>
														</div>
													</List.Item>
												)
											}}
										/>
									</div>

									<div className="univer-ai-changes__detail">
										{ctrl.activePrepared ? (
											<Card
												title={
													<Space spacing="tight">
														<Typography.Text strong>{ctrl.rangeToA1(ctrl.activePrepared.range)}</Typography.Text>
														<Tag size="small" color="light-blue">
															Δ {ctrl.activeVisibleDiffs.length}
														</Tag>
													</Space>
												}
												bordered={false}
											>
												<Typography.Text type="tertiary">{ctrl.activePrepared.reason ?? ctrl.activePrepared.op} · hover cell to inspect old/new</Typography.Text>
												<div className="univer-ai-detail__matrices">
													<div>
														<Typography.Text type="tertiary">原值</Typography.Text>
														<MatrixPreview matrix={ctrl.activePrepared.oldMatrix} />
													</div>
													<div>
														<Typography.Text type="tertiary">新值</Typography.Text>
														<MatrixPreview matrix={ctrl.activePrepared.nextMatrix} />
													</div>
												</div>
												{ctrl.activeVisibleDiffs.length ? (
													<div className="univer-ai-detail__diffs">
														<Typography.Text type="tertiary">变更点（橙=待应用 · 绿=已应用；悬浮单元格查看原值/新值）</Typography.Text>
														<Space spacing="tight" wrap style={{ marginTop: 8 }}>
															<Button
																size="small"
																type="primary"
																disabled={ctrl.previewMode !== 'overlay' || ctrl.busy}
																loading={ctrl.busyOp?.kind === 'applySelected' && ctrl.busyOp.changeId === ctrl.activePrepared?.id}
																onClick={() => void ctrl.applySelectedCells(ctrl.activePrepared!.id)}
															>
																应用选中（{ctrl.activeCellState?.selectedCount ?? 0}）
															</Button>
															<Button
																size="small"
																disabled={ctrl.previewMode !== 'overlay' || ctrl.busy}
																loading={ctrl.busyOp?.kind === 'undoSelected' && ctrl.busyOp.changeId === ctrl.activePrepared?.id}
																onClick={() => void ctrl.undoSelectedCells(ctrl.activePrepared!.id)}
															>
																撤销选中
															</Button>
															<Tag color="light-blue">已应用 {ctrl.activeCellState?.appliedCount ?? 0}</Tag>
															<Tag color="light-blue">总变更点 {ctrl.activeVisibleDiffs.length}</Tag>
															{ctrl.previewMode !== 'overlay' ? <Tag color="orange">写入表格模式下请用 Apply/Undo</Tag> : null}
														</Space>
														<div className="univer-ai-diffchips">
															{ctrl.activeVisibleDiffs.slice(0, 80).map((d) => (
																<div
																	key={`${d.row}:${d.col}`}
																	className="univer-ai-diffchip"
																	data-selected={ctrl.activeCellState?.selected[`${d.row}:${d.col}`] ? 'true' : 'false'}
																	data-applied={ctrl.activeCellState?.applied[`${d.row}:${d.col}`] ? 'true' : 'false'}
																	onClick={() => ctrl.toggleCellSelected(ctrl.activePrepared!.id, d.row, d.col)}
																>
																	<CodeInline>{ctrl.cellToA1(d.row, d.col)}</CodeInline>
																	<span className="univer-ai-diffchip__arrow">→</span>
																	<span className="univer-ai-diffchip__value">{d.nextValue === '' ? '∅' : d.nextValue}</span>
																</div>
															))}
															{ctrl.activeVisibleDiffs.length > 80 ? (
																<Typography.Text type="tertiary">… +{ctrl.activeVisibleDiffs.length - 80}</Typography.Text>
															) : null}
														</div>
													</div>
												) : (
													<Muted>（无可见差异；或已被手动编辑覆盖）</Muted>
												)}
											</Card>
										) : (
											<Muted>选择左侧一条建议查看细节。</Muted>
										)}
									</div>
								</div>
							) : (
								<Muted>（暂无建议。请在「对话」里发送指令。）</Muted>
							)}
						</div>
					</div>
				</Tabs.TabPane>

				<Tabs.TabPane tab="Debug" itemKey="debug">
					<div className="univer-ai-debug">
						<Space spacing="tight" wrap>
							{typeof ctrl.hoverIndexSize === 'number' ? <Tag color="light-blue">hoverIndex: {ctrl.hoverIndexSize}</Tag> : null}
							<Tag color="light-blue">changes: {ctrl.preparedChanges.length}</Tag>
							<Tag color="light-blue">pins: {ctrl.pinnedSelections.length}</Tag>
						</Space>

						<Divider margin="12px 0" />

						<Card title="Selection (TOON preview)" bordered={false}>
							{ctrl.toonPreviewText ? (
								<div className="univer-codeblock">
									<pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{ctrl.toonPreviewText}</pre>
								</div>
							) : (
								<Muted>（无选区）</Muted>
							)}
						</Card>

						<Divider margin="12px 0" />

						<Card title="Meta" bordered={false}>
							<pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{ctrl.meta ? JSON.stringify(ctrl.meta, null, 2) : '(no meta)'}</pre>
						</Card>
					</div>
				</Tabs.TabPane>
			</Tabs>
		</div>
	)
}
