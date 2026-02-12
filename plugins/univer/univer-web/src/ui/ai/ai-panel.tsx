import {
	AIChatDialogue,
	AIChatInput,
	Banner,
	Button,
	Card,
	Divider,
	Space,
	Tag,
	Typography,
} from '@douyinfe/semi-ui-19'
import { IconX } from '@tabler/icons-react'
import { useMemo } from 'react'

import { CodeInline, Muted, SectionTitle } from '../kit'
import { type AiPanelReference, useAiPanelController } from './panel/controller'
import type { AiPanelProps } from './panel/types'

const chatRoleConfig = {
	user: { name: 'You' },
	assistant: { name: 'AI' },
	system: { name: 'System' },
}

function toPanelReference(ref: unknown): AiPanelReference | null {
	if (!ref || typeof ref !== 'object') return null
	const rec = ref as Record<string, unknown>
	if (typeof rec.id !== 'string' || !rec.id) return null
	return {
		type: typeof rec.type === 'string' ? rec.type : 'univer.selection',
		id: rec.id,
		label: typeof rec.label === 'string' ? rec.label : rec.id,
		meta: typeof rec.meta === 'string' ? rec.meta : undefined,
		closable: typeof rec.closable === 'boolean' ? rec.closable : true,
	}
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
						<Button
							size="small"
							theme="borderless"
							disabled={!ctrl.pinnedSelections.length || ctrl.busy}
							onClick={ctrl.clearPins}
						>
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
					<Typography.Text type="tertiary">读取范围</Typography.Text>
					<div className="univer-ai-context__row" style={{ marginTop: 6 }}>
						<Space spacing="tight" align="center">
							<Tag color={ctrl.readScopeMode === 'ranges' ? 'orange' : 'green'}>
								{ctrl.readScopeMode === 'workbook' ? '工作簿' : ctrl.readScopeMode === 'sheet' ? '整表' : '限制'}
							</Tag>
							<Muted>默认整表可读；可在表格里右键“AI → 读取范围 …”限制。</Muted>
						</Space>
					</div>

					{ctrl.readScopes.length ? (
						<div className="univer-ai-context__row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
							{ctrl.readScopes.map((a1) => (
								<span key={a1} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
									<CodeInline>{a1}</CodeInline>
									{ctrl.readScopeMode === 'ranges' ? (
										<Button
											theme="borderless"
											size="small"
											icon={<IconX size={14} />}
											onClick={() => ctrl.removeReadScope(a1)}
											disabled={ctrl.busy}
										/>
									) : null}
								</span>
							))}
						</div>
					) : (
						<Muted>（未能获取读取范围）</Muted>
					)}

					<div className="univer-ai-context__row" style={{ marginTop: 6, flexWrap: 'wrap', gap: 8 }}>
						<Button size="small" theme="borderless" disabled={ctrl.busy} onClick={ctrl.resetReadToSheet}>
							当前表可读
						</Button>
						<Button size="small" theme="borderless" disabled={ctrl.busy} onClick={ctrl.resetReadToWorkbook}>
							工作簿可读
						</Button>
						<Button
							size="small"
							theme="borderless"
							disabled={ctrl.busy || !ctrl.pinnedSelections.length}
							onClick={ctrl.limitReadToPinned}
						>
							限制为情境
						</Button>
						<Button
							size="small"
							theme="borderless"
							disabled={ctrl.busy || !ctrl.pinnedSelections.length}
							onClick={ctrl.addReadFromPinned}
						>
							添加情境
						</Button>
					</div>

					<Divider margin="12px 0" />
				</div>

				<div style={{ marginTop: 8 }}>
					<Typography.Text type="tertiary">写入范围</Typography.Text>
					<div className="univer-ai-context__row" style={{ marginTop: 6 }}>
						<Space spacing="tight" align="center">
							<Tag
								color={ctrl.writeScopeMode === 'none' ? 'grey' : ctrl.writeScopeMode === 'ranges' ? 'orange' : 'green'}
							>
								{ctrl.writeScopeMode === 'none'
									? '只读'
									: ctrl.writeScopeMode === 'workbook'
										? '工作簿'
										: ctrl.writeScopeMode === 'sheet'
											? '整表'
											: '限制'}
							</Tag>
							<Muted>默认只读；需要写入时在表格里右键“AI → 写入权限 …”授权。</Muted>
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
								? '（未设置写入范围；请在表格里右键“AI → 写入权限：限制为选区”。）'
								: ctrl.writeScopeMode === 'none'
									? '（当前为只读；写入会被后端拒绝并提示授权。）'
									: '（未能获取写入范围）'}
						</Muted>
					)}
					{ctrl.writeScopeMode !== 'none' ? <Muted>写入会记录在历史里，可撤销。</Muted> : null}
					<Muted>高亮：紫色=AI 情境（预取/发送） · 蓝色=读取限制 · 橙色=写入限制</Muted>

					<div className="univer-ai-context__row" style={{ marginTop: 6, flexWrap: 'wrap', gap: 8 }}>
						<Button size="small" theme="borderless" disabled={ctrl.busy} onClick={ctrl.disableWrite}>
							只读
						</Button>
						<Button size="small" theme="borderless" disabled={ctrl.busy} onClick={ctrl.allowWriteSheet}>
							允许整表写
						</Button>
						<Button size="small" theme="borderless" disabled={ctrl.busy} onClick={ctrl.allowWriteWorkbook}>
							允许工作簿写
						</Button>
						<Button
							size="small"
							theme="borderless"
							disabled={ctrl.busy || !ctrl.pinnedSelections.length}
							onClick={ctrl.limitWriteToPinned}
						>
							限制为情境
						</Button>
						<Button
							size="small"
							theme="borderless"
							disabled={ctrl.busy || !ctrl.pinnedSelections.length}
							onClick={ctrl.addWriteFromPinned}
						>
							添加情境
						</Button>
					</div>
				</div>

				<Divider margin="12px 0" />
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
						const r = toPanelReference(ref)
						if (!r) return
						if (r.closable === false) return
						ctrl.unpinSelection(r.id)
					}}
					renderReference={(ref) => {
						const r = toPanelReference(ref)
						if (!r) return null
						return (
							<div key={r.id} className="univer-ai-ref" data-closable={r.closable !== false ? 'true' : 'false'}>
								<div className="univer-ai-ref__text">
									<Typography.Text strong>{r.label}</Typography.Text>
									{r.meta ? <Typography.Text type="tertiary">{r.meta}</Typography.Text> : null}
								</div>
								{r.closable !== false ? (
									<Button
										theme="borderless"
										size="small"
										icon={<IconX size={12} />}
										onClick={() => ctrl.unpinSelection(r.id)}
									/>
								) : null}
							</div>
						)
					}}
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
