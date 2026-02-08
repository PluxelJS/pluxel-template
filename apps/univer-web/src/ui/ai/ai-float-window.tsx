import { Button } from '@douyinfe/semi-ui-19'
import { IconChevronLeft, IconChevronRight, IconPin, IconPinnedOff, IconSparkles, IconX } from '@tabler/icons-react'
import { createPortal } from 'react-dom'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

type Position = { top: number; left: number }
type DragAxis = 'both' | 'y'
type DragState = { startX: number; startY: number; startTop: number; startLeft: number; axis: DragAxis }

const EDGE_GAP = 12
const DOCK_THRESHOLD = 28
const DEFAULT_SIZE = { width: 520, height: 680 }

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value))
}

function getInitialPosition(): Position {
	if (typeof window === 'undefined') return { top: 96, left: 24 }
	return {
		top: 96,
		left: Math.max(EDGE_GAP, window.innerWidth - DEFAULT_SIZE.width - EDGE_GAP),
	}
}

export function AiFloatWindow(props: {
	open: boolean
	openSeq?: number
	onOpenChange(open: boolean): void
	title: string
	defaultDocked?: boolean
	defaultCollapsed?: boolean
	children: ReactNode
}) {
	const initialDocked = Boolean(props.defaultDocked ?? false) || Boolean(props.defaultCollapsed ?? false)
	const [docked, setDocked] = useState(initialDocked)
	const [collapsed, setCollapsed] = useState(Boolean(props.defaultCollapsed ?? false))
	const [position, setPosition] = useState<Position>(getInitialPosition)
	const [dragging, setDragging] = useState(false)

	const panelRef = useRef<HTMLDivElement | null>(null)
	const dragRef = useRef<DragState | null>(null)
	const positionRef = useRef(position)
	const dockedRef = useRef(docked)
	const floatPosRef = useRef(position)
	const openSeqRef = useRef<number | undefined>(props.openSeq)

	useEffect(() => {
		positionRef.current = position
	}, [position])

	useEffect(() => {
		dockedRef.current = docked
		if (!docked) floatPosRef.current = position
	}, [docked, position])

	useEffect(() => {
		if (!props.open) return
		if (props.openSeq === openSeqRef.current) return
		openSeqRef.current = props.openSeq
		setCollapsed(false)
	}, [props.open, props.openSeq])

	const getPanelSize = useCallback(() => {
		const rect = panelRef.current?.getBoundingClientRect()
		return {
			width: rect?.width ?? DEFAULT_SIZE.width,
			height: rect?.height ?? DEFAULT_SIZE.height,
		}
	}, [])

	const clampPosition = useCallback(
		(next: Position) => {
			if (typeof window === 'undefined') return next
			const { width: panelWidth, height: panelHeight } = getPanelSize()
			const maxLeft = Math.max(EDGE_GAP, window.innerWidth - panelWidth - EDGE_GAP)
			const maxTop = Math.max(EDGE_GAP, window.innerHeight - panelHeight - EDGE_GAP)
			return {
				top: clamp(next.top, EDGE_GAP, maxTop),
				left: clamp(next.left, EDGE_GAP, maxLeft),
			}
		},
		[getPanelSize],
	)

	useEffect(() => {
		if (!props.open) return
		const onResize = () => {
			setPosition((prev) => clampPosition(prev))
		}
		window.addEventListener('resize', onResize)
		return () => window.removeEventListener('resize', onResize)
	}, [clampPosition, props.open])

	useEffect(() => {
		if (!dragging) return
		const handleMove = (event: PointerEvent) => {
			const drag = dragRef.current
			if (!drag) return
			const dx = event.clientX - drag.startX
			const dy = event.clientY - drag.startY
			const next: Position = {
				top: drag.startTop + dy,
				left: drag.axis === 'y' ? drag.startLeft : drag.startLeft + dx,
			}
			setPosition(clampPosition(next))
		}

		const handleUp = () => {
			setDragging(false)
			dragRef.current = null
			if (typeof window === 'undefined') return
			if (dockedRef.current) return
			const pos = positionRef.current
			const { width: panelWidth } = getPanelSize()
			const shouldDock = window.innerWidth - (pos.left + panelWidth) < DOCK_THRESHOLD
			if (shouldDock) {
				setDocked(true)
				setCollapsed(true)
			}
		}

		window.addEventListener('pointermove', handleMove)
		window.addEventListener('pointerup', handleUp)
		return () => {
			window.removeEventListener('pointermove', handleMove)
			window.removeEventListener('pointerup', handleUp)
		}
	}, [clampPosition, dragging, getPanelSize])

	const startDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return
		if ((event.target as HTMLElement).closest('[data-ai-nodrag]')) return
		event.preventDefault()
		if (dockedRef.current) {
			setDocked(false)
			setCollapsed(false)
			setPosition(floatPosRef.current)
		}
		const pos = positionRef.current
		dragRef.current = {
			startX: event.clientX,
			startY: event.clientY,
			startTop: pos.top,
			startLeft: pos.left,
			axis: 'both',
		}
		setDragging(true)
	}, [])

	const startTabDrag = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
		if (event.button !== 0) return
		event.preventDefault()
		const pos = positionRef.current
		dragRef.current = {
			startX: event.clientX,
			startY: event.clientY,
			startTop: pos.top,
			startLeft: pos.left,
			axis: 'y',
		}
		setDragging(true)
	}, [])

	const dockNow = useCallback(() => {
		if (typeof window === 'undefined') return
		const { width: panelWidth, height: panelHeight } = getPanelSize()
		const top = clamp(positionRef.current.top, EDGE_GAP, Math.max(EDGE_GAP, window.innerHeight - panelHeight - EDGE_GAP))
		setPosition({
			top,
			left: Math.max(EDGE_GAP, window.innerWidth - panelWidth - EDGE_GAP),
		})
		setDocked(true)
	}, [getPanelSize])

	const undockNow = useCallback(() => {
		setDocked(false)
		setCollapsed(false)
		setPosition(floatPosRef.current)
	}, [])

	const toggleCollapse = useCallback(() => {
		if (!dockedRef.current) return
		setCollapsed((prev) => !prev)
	}, [])

	const openPanel = useCallback(() => {
		setCollapsed(false)
	}, [])

	const rootStyle = useMemo<React.CSSProperties>(() => {
		if (typeof window === 'undefined') return {}
		if (docked) {
			return {
				top: position.top,
				right: EDGE_GAP,
			}
		}
		return {
			top: position.top,
			left: position.left,
		}
	}, [docked, position.left, position.top])

	if (!props.open) return null

	return createPortal(
		<div className="univer-ai-float-layer">
			<button
				className="univer-ai-float__tab"
				style={{ top: position.top }}
				data-visible={docked && collapsed ? 'true' : 'false'}
				onClick={openPanel}
				onPointerDown={startTabDrag}
			>
				<IconSparkles size={16} />
				<span>AI</span>
			</button>

			<div
				ref={panelRef}
				className="univer-ai-float"
				data-docked={docked ? 'true' : 'false'}
				data-collapsed={collapsed ? 'true' : 'false'}
				style={rootStyle}
			>
				<div className="univer-ai-float__header" onPointerDown={startDrag}>
					<div className="univer-ai-float__title">
						<IconSparkles size={16} />
						<span>{props.title}</span>
					</div>
					<div className="univer-ai-float__actions">
						<span style={{ display: 'inline-flex' }} title={docked ? '取消靠边' : '靠边停靠'}>
							<Button
								data-ai-nodrag
								theme="borderless"
								size="small"
								icon={docked ? <IconPinnedOff size={16} /> : <IconPin size={16} />}
								onClick={() => {
									if (dockedRef.current) undockNow()
									else dockNow()
								}}
							/>
						</span>
						{docked ? (
							<span style={{ display: 'inline-flex' }} title={collapsed ? '展开' : '收起'}>
								<Button
									data-ai-nodrag
									theme="borderless"
									size="small"
									icon={collapsed ? <IconChevronLeft size={16} /> : <IconChevronRight size={16} />}
									onClick={toggleCollapse}
								/>
							</span>
						) : null}
						<span style={{ display: 'inline-flex' }} title="关闭">
							<Button
								data-ai-nodrag
								theme="borderless"
								size="small"
								icon={<IconX size={16} />}
								onClick={() => props.onOpenChange(false)}
							/>
						</span>
					</div>
				</div>
				<div className="univer-ai-float__body">{props.children}</div>
			</div>
		</div>,
		document.body,
	)
}
