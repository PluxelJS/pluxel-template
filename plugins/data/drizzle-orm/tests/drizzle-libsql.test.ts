import { describe, expect, it } from 'vitest'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'

describe('drizzle-orm/libsql (vite+vitest)', () => {
	it('can create db and run query', async () => {
		const client = createClient({ url: 'file::memory:' })
		try {
			const db = drizzle(client)
			const rs = await db.all<{ x: number }>('select 1 as x')
			expect(rs[0]?.x).toBe(1)
		} finally {
			client.close()
		}
	})
})

