import { IUndoRedoService } from '@univerjs/core'
import type { FUniver } from '@univerjs/core/facade'

export function createUndoBatcher(univer: { __getInjector(): any }, api: FUniver, fallbackUnitId: string) {
	return async <T,>(fn: () => Promise<T> | T): Promise<T> => {
		const fWorkbook = api.getActiveWorkbook()
		const unitId = fWorkbook?.getId() ?? fallbackUnitId
		const injector = univer.__getInjector()
		const undoRedo = injector.get(IUndoRedoService)
		const batching = undoRedo.__tempBatchingUndoRedo(unitId)
		try {
			return await fn()
		} finally {
			batching.dispose()
		}
	}
}
