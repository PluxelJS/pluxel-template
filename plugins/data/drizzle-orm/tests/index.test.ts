import { describe, expect, it } from 'vitest'

describe('pluxel-plugin-drizzle-orm (libsql)', () => {
	it('tableFactory preserves baseName and table name', async () => {
		const { sqliteTable, integer, text } = await import('drizzle-orm/sqlite-core')
		const { getTableName } = await import('drizzle-orm/table')

		const { tableFactory } = await import('../src/drizzle-orm.ts')
		const Users = tableFactory('users', (tableName: string) =>
			sqliteTable(tableName, {
				id: integer('id').primaryKey({ autoIncrement: true }),
				name: text('name').notNull(),
			}),
		)

		expect(Users.baseName).toBe('users')
		expect(getTableName(Users('Script_users'))).toBe('Script_users')
	})
})
