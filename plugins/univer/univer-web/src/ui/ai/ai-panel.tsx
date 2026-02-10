import {
	AIChatDialogue,
	AIChatInput,
	Banner,
	Button,
	Card,
	Collapse,
	Divider,
	InputNumber,
	Select,
	Space,
	Tag,
	Typography,
} from '@douyinfe/semi-ui-19'
import { IconPin, IconRefresh, IconX } from '@tabler/icons-react'
import { useMemo } from 'react'

import { CodeInline, Muted, SectionTitle } from '../kit'
import { useAiPanelController } from './panel/controller'
import type { AiPanelProps } from './panel/types'

const chatRoleConfig = {
	user: { name: 'You' },
	assistant: { name: 'AI' },
	system: { name: 'System' },
}

export function AiPanel(props: AiPanelProps) {
	const ctrl = useAiPanelController(props)

	const backendTag = useMemo(() => {
		if (!props.backend) return <Tag color="grey">Loopback 未启用</Tag>
		if (props.dirty) return <Tag color="orange">未保存</Tag>
		return <Tag color="green">Loopback Ready</Tag>
	}, [props.backend, props.dirty])

	return (
		<div className="univer-ai-panel">
			<div className="univer-ai-panel__top">
				<div className="univer-ai-panel__title">
					<SectionTitle>AI Assistant</SectionTitle>
					{backendTag}
				</div>
				<Space spacing="tight">
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
									<CodeInline>{ctrl.currentSelection.a1 ?? '(A1 unknown)'}</CodeInline>
									<Typography.Text type="tertiary">{ctrl.selectionLabel(ctrl.currentSelection)}</Typography.Text>
								</>
							) : (
								<Typography.Text type="tertiary">（未选中）</Typography.Text>
							)}
						</div>
					</div>
					<div className="univer-ai-context__actions">
						<Button size="small" icon={<IconPin size={16} />} onClick={ctrl.pinCurrentSelection} disabled={!props.ready || ctrl.busy}>
							固定为上下文
						</Button>
						<Button size="small" theme="borderless" disabled={!ctrl.pinnedSelections.length || ctrl.busy} onClick={ctrl.clearPins}>
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
									<Button
										theme="borderless"
										size="small"
										icon={<IconX size={14} />}
										onClick={() => ctrl.unpinSelection(id)}
										disabled={ctrl.busy}
									/>
								</div>
							)
						})}
					</div>
				) : (
					<Muted>（未固定额外上下文。可固定多个选区，用于跨片段对比/汇总。）</Muted>
				)}

				<Divider margin="12px 0" />

				<Collapse accordion>
					<Collapse.Panel header="高级选项" itemKey="advanced">
						<div style={{ display: 'grid', gap: 10 }}>
							<div>
								<Typography.Text type="tertiary">写入策略</Typography.Text>
								<Space spacing="tight" align="center" style={{ marginTop: 8 }}>
									<Typography.Text type="tertiary">WRITE</Typography.Text>
									<Select
										size="small"
										style={{ width: 180 }}
										value={ctrl.writeMode}
										disabled={!props.ready || ctrl.busy}
										onChange={(v) => ctrl.setWriteMode((v as any) ?? 'scoped')}
										optionList={[
											{ label: '仅选区（安全）', value: 'scoped' },
											{ label: '等于 READ（宽松）', value: 'table' },
										]}
									/>
									<Tag color={ctrl.writeMode === 'table' ? 'violet' : 'light-blue'}>{ctrl.writeMode}</Tag>
								</Space>
								<Space spacing="tight" align="center" style={{ marginTop: 8 }}>
									<Typography.Text type="tertiary">FillDown</Typography.Text>
									<InputNumber
										size="small"
										min={0}
										max={ctrl.maxFillDownRows}
										style={{ width: 88 }}
										value={ctrl.fillDownRows}
										disabled={!props.ready || ctrl.busy || ctrl.writeMode !== 'scoped' || ctrl.maxFillDownRows <= 0}
										onChange={(v) => ctrl.setFillDownRows(typeof v === 'number' ? v : Number(v))}
									/>
									<Typography.Text type="tertiary">行</Typography.Text>
								</Space>
							</div>

							<div>
								<Typography.Text type="tertiary">Loopback</Typography.Text>
								<Space spacing="tight" align="center" style={{ marginTop: 8 }}>
									<Typography.Text type="tertiary">rounds≤</Typography.Text>
									<InputNumber
										size="small"
										min={1}
										max={10}
										style={{ width: 88 }}
										value={ctrl.loopMaxRounds}
										disabled={!props.ready || ctrl.busy}
										onChange={(v) => ctrl.setLoopMaxRounds(typeof v === 'number' ? v : Number(v))}
									/>
									<Select
										size="small"
										style={{ width: 140 }}
										value={ctrl.mode}
										disabled={!props.ready || ctrl.busy}
										onChange={(v) => ctrl.setMode((v as any) ?? 'safe')}
										optionList={[
											{ label: 'safe', value: 'safe' },
											{ label: 'aggressive', value: 'aggressive' },
										]}
									/>
								</Space>
								<div style={{ marginTop: 8 }}>
									<Muted>
										本面板只发指令+范围到后端；后端用 Headless Univer 执行 loopback，最终提交新快照并刷新编辑器。
									</Muted>
								</div>
							</div>
						</div>
					</Collapse.Panel>
				</Collapse>
			</Card>

			<Divider margin="12px 0" />

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
					canSend={Boolean(props.backend) && !props.dirty && !ctrl.busy}
					generating={ctrl.busy}
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
					<Typography.Text type="tertiary">
						上下文：<CodeInline>A1 scopes</CodeInline> · 后端：<CodeInline>TOON</CodeInline>
					</Typography.Text>
				</div>
			</div>
		</div>
	)
}
