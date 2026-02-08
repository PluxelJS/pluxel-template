import { FUniver } from '@univerjs/core/facade'
import '@univerjs/sheets/facade'
import '@univerjs/sheets-ui/facade'
import '@univerjs/ui/facade'
import { IUniverInstanceService, Univer as UniverCtor } from '@univerjs/core'
import { ILayoutService } from '@univerjs/ui'

import { registerAiMenu } from './ai-menu'
import { createUniverLocaleConfig } from './locales'
import { createRangeHighlighter } from './overlay'
import { registerUniverPlugins } from './plugins'
import { normalizeWorkbookSnapshot } from './snapshot'
import { createUndoBatcher } from './undo'
import { createWatermarkController } from './watermark'

export type UniverRuntime = {
	univer: UniverCtor
	api: FUniver
	workbookId: string
	workbookName: string
	installedPlugins: ReadonlySet<string>
	dispose(): void
	applyWatermark(config: unknown): void
	clearWatermark(): void
	clearOverlay(): void
	highlightRange(input: {
		sheetId?: string | null
		range: { startRow: number; startCol: number; endRow: number; endCol: number }
		style?: unknown
		durationMs?: number
	}): void
	withUndoBatch<T>(fn: () => Promise<T> | T): Promise<T>
	saveSnapshotJson(): string
}

export function createUniverRuntime(input: {
	mountEl: HTMLElement
	workbookId: string
	workbookName: string
	snapshot?: unknown
	installedPlugins?: readonly string[]
	onAiOpen?: () => void
}): UniverRuntime {
	// Best-effort cleanup: UI plugins may leave DOM behind when the runtime is created/disposed rapidly
	// (e.g. Storybook + React StrictMode / HMR).
	input.mountEl.innerHTML = ''

	let disposed = false
	const focusTimers: number[] = []
	let focusRaf: number | null = null

	const univer = new UniverCtor(createUniverLocaleConfig())
	const installedPlugins = new Set(input.installedPlugins ?? [])

	const { watermarkInstalled } = registerUniverPlugins(univer, {
		mountEl: input.mountEl,
		installedPlugins,
	})

	const api = FUniver.newAPI(univer)
	const aiCommandDisposable = input.onAiOpen ? registerAiMenu(univer, input.onAiOpen) : null
	const fWorkbook = api.createWorkbook(normalizeWorkbookSnapshot(input))
	const workbookId = fWorkbook.getId()

	// Ensure the created workbook becomes the focused/current unit in embedding environments (e.g. Storybook iframe),
	// otherwise keyboard-driven editing may not be activated even though selection works.
	fWorkbook.setEditable(true)
	void fWorkbook.getWorkbookPermission().setEditable()
	const instanceService = univer.__getInjector().get(IUniverInstanceService)
	const layoutService = univer.__getInjector().get(ILayoutService)

	// The workbench mounts renderers async; re-run focus after paint so keyboard editing works reliably in iframes.
	const focusLater = () => {
		if (disposed) return
		instanceService.setCurrentUnitForType(workbookId)
		instanceService.focusUnit(workbookId)
		layoutService.focus()

		// Help Storybook/iframe: click-to-focus does not always trigger focusin on canvas, so we focus it ourselves.
		const root = layoutService.rootContainerElement ?? input.mountEl
		const el =
			(root.querySelector('[data-u-comp="render-canvas"]') as HTMLElement | null) ??
			(root.querySelector('[data-range-selector]') as HTMLElement | null) ??
			(root.querySelector('[data-u-comp="workbench-layout"]') as HTMLElement | null) ??
			null
		if (el) {
			if (el.tabIndex < 0) el.tabIndex = 0
			el.focus({ preventScroll: true })
			return
		}

		try {
			const contentEl = layoutService.getContentElement()
			if (contentEl.tabIndex < 0) contentEl.tabIndex = 0
			contentEl.focus({ preventScroll: true })
		} catch {}
	}
	const scheduleFocus = (ms: number) => {
		focusTimers.push(
			window.setTimeout(() => {
				focusLater()
			}, ms),
		)
	}
	focusLater()
	if (typeof requestAnimationFrame === 'function') {
		focusRaf = requestAnimationFrame(focusLater)
	} else {
		scheduleFocus(0)
	}
	scheduleFocus(350)
	scheduleFocus(800)

	const onPointerDown = () => focusLater()
	input.mountEl.addEventListener('pointerdown', onPointerDown)

	const watermark = createWatermarkController(univer, watermarkInstalled)
	const overlay = createRangeHighlighter(api)
	const withUndoBatch = createUndoBatcher(univer, api, workbookId)

	const saveSnapshotJson = () => {
		const fWorkbook = api.getActiveWorkbook()
		if (!fWorkbook) throw new Error('[univer] no active workbook')
		const snapshot = fWorkbook.save()
		return JSON.stringify(snapshot)
	}

	const dispose = () => {
		disposed = true
		for (const t of focusTimers) window.clearTimeout(t)
		focusTimers.length = 0
		if (typeof cancelAnimationFrame === 'function' && typeof focusRaf === 'number') {
			cancelAnimationFrame(focusRaf)
		}
		focusRaf = null
		input.mountEl.removeEventListener('pointerdown', onPointerDown)
		overlay.clear()
		watermark.clear()
		aiCommandDisposable?.dispose()
		api.dispose()
		univer.dispose()
		input.mountEl.innerHTML = ''
	}

	return {
		univer,
		api,
		workbookId,
		workbookName: input.workbookName,
		installedPlugins,
		dispose,
		applyWatermark: watermark.apply,
		clearWatermark: watermark.clear,
		clearOverlay: overlay.clear,
		highlightRange: overlay.highlight,
		withUndoBatch,
		saveSnapshotJson,
	}
}
