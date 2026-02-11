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
import { IconX } from '@tabler/icons-react'
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
				</div>

			{ctrl.warn ? <Banner fullMode={false} type="warning" title="提示" description={ctrl.warn} /> : null}
			{ctrl.error ? <Banner fullMode={false} type="danger" title="错误" description={ctrl.error} /> : null}

			<Card bordered={false} className="univer-ai-panel__context" bodyStyle={{ padding: 12 }}>
				<div className="univer-ai-context">
					<div className="univer-ai-context__current">
						<Typography.Text type="tertiary">AI 情境</Typography.Text>
						<div className="univer-ai-context__row">
							<Muted>在表格里右键“AI → 添加到 AI 情境”管理上下文（支持 Ctrl 多选）。</Muted>
						</div>
					</div>
					<div className="univer-ai-context__actions">
						<Button size="small" theme="borderless" disabled={!ctrl.pinnedSelections.length || ctrl.busy} onClick={ctrl.clearPins}>
							清空
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
					<Muted>（未添加情境）</Muted>
				)}

				<div style={{ marginTop: 8 }}>
					<Typography.Text type="tertiary">写入范围</Typography.Text>
					<div className="univer-ai-context__row" style={{ marginTop: 6 }}>
						<Space spacing="tight" align="center">
							<Tag color={ctrl.writeScopeMode === 'sheet' ? 'green' : 'orange'}>
								{ctrl.writeScopeMode === 'sheet' ? '整表' : '限制'}
							</Tag>
							<Muted>在表格里右键“AI → 写入范围 …”调整。</Muted>
						</Space>
					</div>

					{ctrl.editableScopes.length ? (
						<div className="univer-ai-context__row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
							{ctrl.editableScopes.map((a1) => (
								<span key={a1} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
									<CodeInline>{a1}</CodeInline>
									{ctrl.writeScopeMode === 'ranges' ? (
										<Button
											theme="borderless"
											size="small"
											icon={<IconX size={14} />}
											onClick={() => ctrl.removeWriteScope(a1)}
											disabled={ctrl.busy}
										/>
									) : null}
								</span>
							))}
						</div>
					) : (
						<Muted>
							{ctrl.writeScopeMode === 'ranges'
								? '（未设置写入范围；请在表格里右键“AI → 写入范围：限制为选区”。）'
								: '（未能获取写入范围）'}
						</Muted>
					)}
					<Muted>写入会记录在历史里，可撤销。</Muted>
					<Muted>高亮：紫色=AI 情境（预取/发送） · 橙色=写入限制（仅“限制”模式）</Muted>
				</div>

				<Divider margin="12px 0" />

				<Collapse accordion>
					<Collapse.Panel header="高级选项" itemKey="advanced">
						<div>
							<Typography.Text type="tertiary">Loopback</Typography.Text>
							<Space spacing="tight" align="center" style={{ marginTop: 8 }}>
								<Typography.Text type="tertiary">steps≤</Typography.Text>
								<InputNumber
									size="small"
									min={1}
									max={80}
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
								<Muted>steps 只是安全上限，模型会在完成任务并验证后提前结束。本面板只发指令+范围到后端；后端用 Headless Univer 执行 loopback，最终提交新快照并刷新编辑器。</Muted>
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
					placeholder="右键将选区添加到 AI 情境后，描述你希望 AI 完成的修改…"
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
							上下文：<CodeInline>A1 scopes</CodeInline> · 后端：<CodeInline>Ax+Tools</CodeInline>
						</Typography.Text>
					</div>
				</div>
		</div>
	)
}
