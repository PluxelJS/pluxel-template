import '@pluxel/hmr/services'
import { describe, it } from 'vitest'
import { withHost } from '@pluxel/test'

import { UniverSheetsStudio } from '../src'

describe('pluxel-plugin-univer-sheets-studio', () => {
	it('starts in core runtime (no ext registration)', async () => {
		await withHost(async (host) => {
			host.add(UniverSheetsStudio)
			await host.commit()
		})
	})
})

