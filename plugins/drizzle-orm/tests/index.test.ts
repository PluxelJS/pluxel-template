import { describe, expect, it } from 'bun:test'
import { BasePlugin, Plugin, setParamToken, withTestHost } from '@pluxel/core/test'
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core'

import { DrizzleOrm, DrizzleOrmLibsql, tableFactory } from '../src/drizzle-orm.ts'

const Users = tableFactory('users', (tableName: string) =>
	sqliteTable(tableName, {
		id: integer('id').primaryKey({ autoIncrement: true }),
		name: text('name').notNull(),
	}),
)

@Plugin({ name: 'CallerA', type: 'service' })
class CallerA extends BasePlugin {
	constructor(private readonly db: DrizzleOrm) {
		super()
	}

	async register() {
		return await this.db.registerTable(Users)
	}
}

setParamToken(CallerA, 0, DrizzleOrm)

describe('pluxel-plugin-drizzle-orm (libsql)', () => {
	it('supports explicit scope without caller context', async () => {
		await withTestHost(async (host) => {
			host.register(DrizzleOrmLibsql)
			host.setConfig('DrizzleOrm', { config: { dbName: ':memory:' } })
			await host.commitStrict()

			const drizzle = host.getOrThrow(DrizzleOrm)
			const handle = await drizzle.scope('Script').registerTable(Users)
			expect(handle.tableName).toBe('Script_users')
		})
	})

	it('registers table and ensures schema in :memory:', async () => {
		await withTestHost(async (host) => {
			host.register(DrizzleOrmLibsql)
			host.register(CallerA)
			host.setConfig('DrizzleOrm', { config: { dbName: ':memory:' } })
			await host.commitStrict()

			const handle = await host.getOrThrow(CallerA).register()
			expect(handle.tableName).toBe('CallerA_users')

			const drizzle = host.getOrThrow(DrizzleOrm)
			const rs = await drizzle.execute(
				"select name from sqlite_master where type='table' and name=?",
				[handle.tableName],
			)
			expect(rs.rows.length).toBe(1)
		})
	})
})
