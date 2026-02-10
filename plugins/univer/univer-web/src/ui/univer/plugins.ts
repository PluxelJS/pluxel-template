import type { Univer as UniverCtor } from '@univerjs/core'
import { UniverDocsPlugin } from '@univerjs/docs'
import { UniverDocsUIPlugin } from '@univerjs/docs-ui'
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula'
import { UniverRenderEnginePlugin } from '@univerjs/engine-render'
import { UniverSheetsPlugin } from '@univerjs/sheets'
import { UniverSheetsFormulaUIPlugin } from '@univerjs/sheets-formula-ui'
import { UniverSheetsUIPlugin } from '@univerjs/sheets-ui'
import { UniverUIPlugin } from '@univerjs/ui'
import { UniverWatermarkPlugin } from '@univerjs/watermark'

export function registerUniverPlugins(
	univer: UniverCtor,
	input: { mountEl: HTMLElement; installedPlugins: ReadonlySet<string> },
) {
	univer.registerPlugin(UniverRenderEnginePlugin)
	univer.registerPlugin(UniverFormulaEnginePlugin)
	univer.registerPlugin(UniverUIPlugin, { container: input.mountEl })
	// Sheets cell editing depends on Docs editor services provided by Docs/DocsUI.
	univer.registerPlugin(UniverDocsPlugin)
	univer.registerPlugin(UniverDocsUIPlugin, { container: input.mountEl })
	univer.registerPlugin(UniverSheetsPlugin)
	univer.registerPlugin(UniverSheetsUIPlugin, {
		disableEdit: false,
	})
	univer.registerPlugin(UniverSheetsFormulaUIPlugin)

	const watermarkInstalled = input.installedPlugins.has('watermark')
	if (watermarkInstalled) {
		univer.registerPlugin(UniverWatermarkPlugin)
	}

	return { watermarkInstalled }
}
