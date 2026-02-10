import { Modal } from '@douyinfe/semi-ui-19'
import type { ReactNode } from 'react'

export function CodeInline({ children }: { children: ReactNode }) {
	return <code className="univer-code">{children}</code>
}

export function PageTitle({ children }: { children: ReactNode }) {
	return <h2 className="univer-title">{children}</h2>
}

export function SectionTitle({ children }: { children: ReactNode }) {
	return <h3 className="univer-section-title">{children}</h3>
}

export function Muted({ children }: { children: ReactNode }) {
	return <p className="univer-muted">{children}</p>
}

const modalWidthBySize: Record<'sm' | 'md' | 'lg' | 'full', number | string> = {
	sm: 420,
	md: 560,
	lg: 760,
	full: '92vw',
}

export function AppModal(props: {
	open: boolean
	onOpenChange(open: boolean): void
	title: string
	size?: 'sm' | 'md' | 'lg' | 'full'
	children: ReactNode
	footer?: ReactNode
	containerClassName?: string
}) {
	const size = props.size ?? 'md'

	return (
		<Modal
			visible={props.open}
			title={props.title}
			width={modalWidthBySize[size]}
			centered
			maskClosable
			className={props.containerClassName}
			footer={props.footer ?? null}
			onCancel={() => props.onOpenChange(false)}
			bodyStyle={{ maxHeight: size === 'full' ? '72vh' : '60vh', overflow: 'auto' }}
		>
			{props.children}
		</Modal>
	)
}
