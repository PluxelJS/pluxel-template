import { Button, Space, Tag, Typography } from '@douyinfe/semi-ui-19'

export const AI_HOVER_CELL_POPUP_KEY = 'univer-ai-hover-cell-popup'

export type HoverCellPopupPayload = {
	title: string
	state: 'suggested' | 'preview' | 'applied'
	oldValue: string
	nextValue: string
	reason?: string | null
	actions?: {
		apply?: { disabled?: boolean; onClick(): void }
		undo?: { disabled?: boolean; onClick(): void }
		ignore?: { disabled?: boolean; onClick(): void }
	}
}

export function HoverCellPopup(props: HoverCellPopupPayload) {
	const actions = props.actions
	const hasActions = Boolean(actions?.apply || actions?.undo || actions?.ignore)
	return (
		<div className="univer-ai-hover-popup" data-state={props.state}>
			<div className="univer-ai-hover-popup__header">
				<Typography.Text strong>{props.title}</Typography.Text>
				<Tag size="small" color={props.state === 'applied' ? 'green' : props.state === 'preview' ? 'orange' : 'blue'}>
					{props.state.toUpperCase()}
				</Tag>
			</div>
			<div className="univer-ai-hover-popup__grid">
				<div>
					<div className="univer-ai-hover-popup__label">原值</div>
					<div className="univer-ai-hover-popup__value">{props.oldValue === '' ? '∅' : props.oldValue}</div>
				</div>
				<div>
					<div className="univer-ai-hover-popup__label">新值</div>
					<div className="univer-ai-hover-popup__value">{props.nextValue === '' ? '∅' : props.nextValue}</div>
				</div>
			</div>
			{props.reason ? <div className="univer-ai-hover-popup__reason">{props.reason}</div> : null}
			{hasActions ? (
				<div className="univer-ai-hover-popup__actions">
					<Space spacing="tight">
						{actions?.apply ? (
							<Button size="small" type="primary" disabled={actions.apply.disabled} onClick={actions.apply.onClick}>
								Apply
							</Button>
						) : null}
						{actions?.undo ? (
							<Button size="small" disabled={actions.undo.disabled} onClick={actions.undo.onClick}>
								Undo
							</Button>
						) : null}
						{actions?.ignore ? (
							<Button size="small" theme="borderless" disabled={actions.ignore.disabled} onClick={actions.ignore.onClick}>
								Ignore
							</Button>
						) : null}
					</Space>
				</div>
			) : null}
		</div>
	)
}
