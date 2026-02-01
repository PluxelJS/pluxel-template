import { describe, expect, it } from 'vitest'
import { createClient } from '@libsql/client'

describe('@libsql/client (vite+vitest)', () => {
	it('can create in-memory client and run query', async () => {
		const client = createClient({ url: 'file::memory:' })
		try {
			const rs = await client.execute('select 1 as x')
			expect(rs.rows?.[0]?.x).toBe(1)
		} finally {
			client.close()
		}
	})
})

