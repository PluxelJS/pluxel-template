import { LocaleType } from '@univerjs/core'
import { createUniver } from '@univerjs/presets'
import { UniverSheetsNodeCorePreset } from '@univerjs/preset-sheets-node-core'

export type HeadlessUniverEngine = {
	withWorkbook<T>(snapshot: unknown, fn: (workbook: any) => Promise<T> | T): Promise<T>
	dispose(): void
}

export function createHeadlessUniverEngine(opts?: { locale?: LocaleType }) {
	const { univer, univerAPI } = createUniver({
		locale: opts?.locale ?? LocaleType.ZH_CN,
		locales: {},
		presets: [UniverSheetsNodeCorePreset()],
	})

	let disposed = false

	const withWorkbook: HeadlessUniverEngine['withWorkbook'] = async (snapshot, fn) => {
		if (disposed) throw new Error('[univer] headless engine disposed')
		const workbook = (univerAPI as any).createWorkbook(snapshot as any)
		if (!workbook) throw new Error('[univer] failed to create workbook')
		const unitId = typeof workbook.getId === 'function' ? String(workbook.getId()) : ''
		try {
			return await fn(workbook)
		} finally {
			try {
				if (unitId) (univerAPI as any).disposeUnit?.(unitId)
			} catch {}
		}
	}

	return {
		withWorkbook,
		dispose() {
			if (disposed) return
			disposed = true
			try {
				univer.dispose()
			} catch {}
		},
	} satisfies HeadlessUniverEngine
}
