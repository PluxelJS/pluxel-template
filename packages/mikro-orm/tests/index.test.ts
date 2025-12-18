import { describe, expect, it } from 'bun:test'

import { BasePlugin, Plugin, withTestHost } from '@pluxel/hmr/test'
import { EntitySchema } from '@mikro-orm/core'

import { MikroOrm, MikroOrmLibsql, type RegisterEntityOptions } from '../src/mikro-orm.ts'

const UserSchema = new EntitySchema({
	name: 'User',
	tableName: 'users',
	properties: {
		id: { primary: true, type: 'number' },
		name: { type: 'string' },
	},
})

const ConflictUserSchema = new EntitySchema({
	name: 'OtherUser',
	tableName: 'users',
	properties: {
		id: { primary: true, type: 'number' },
	},
})

async function listTables(mikro: MikroOrm) {
	const orm = await mikro.orm()
	return orm.em.getConnection().execute(
		"select name from sqlite_master where type='table' order by name",
	) as Promise<Array<{ name: string }>>
}

async function hasTable(mikro: MikroOrm, tableName: string) {
	const rows = await (await mikro.orm()).em
		.getConnection()
		.execute("select name from sqlite_master where type='table' and name=?", [tableName])
	return Array.isArray(rows) && rows.length > 0
}

async function insertUserRow(mikro: MikroOrm, tableName: string, id: number, name: string) {
	const orm = await mikro.orm()
	const q = orm.em.getPlatform().quoteIdentifier(tableName)
	await orm.em.getConnection().execute(`insert into ${q} (id, name) values (?, ?)`, [id, name])
}

async function listUserIds(mikro: MikroOrm, tableName: string) {
	const orm = await mikro.orm()
	const q = orm.em.getPlatform().quoteIdentifier(tableName)
	const rows = (await orm.em.getConnection().execute(`select id from ${q} order by id`)) as Array<{ id: number }>
	return rows.map((r) => r.id)
}

@Plugin({ name: 'CallerA', type: 'service' })
class CallerA extends BasePlugin {
	constructor(private readonly mikro: MikroOrm) {
		super()
	}

	registerUser(options?: RegisterEntityOptions) {
		return this.mikro.registerEntity(UserSchema, options)
	}

	registerConflictUser(options?: RegisterEntityOptions) {
		return this.mikro.registerEntity(ConflictUserSchema, options)
	}
}

@Plugin({ name: 'CallerB', type: 'service' })
class CallerB extends BasePlugin {
	constructor(private readonly mikro: MikroOrm) {
		super()
	}

	registerUser(options?: RegisterEntityOptions) {
		return this.mikro.registerEntity(UserSchema, options)
	}
}

@Plugin({ name: 'Wrapper', type: 'service' })
class Wrapper extends BasePlugin {
	constructor(private readonly mikro: MikroOrm) {
		super()
	}

	registerUser() {
		return this.mikro.registerEntity(UserSchema)
	}
}

@Plugin({ name: 'Outer', type: 'service' })
class Outer extends BasePlugin {
	constructor(private readonly wrapper: Wrapper) {
		super()
	}

	registerUserViaWrapper() {
		return this.wrapper.registerUser()
	}
}

@Plugin({ name: 'a-b', type: 'service' })
class CallerDash extends BasePlugin {
	constructor(private readonly mikro: MikroOrm) {
		super()
	}

	registerUser(options?: RegisterEntityOptions) {
		return this.mikro.registerEntity(UserSchema, options)
	}
}

@Plugin({ name: 'a_b', type: 'service' })
class CallerUnderscore extends BasePlugin {
	constructor(private readonly mikro: MikroOrm) {
		super()
	}

	registerUser(options?: RegisterEntityOptions) {
		return this.mikro.registerEntity(UserSchema, options)
	}
}

describe('pluxel-plugin-mikro-orm (libsql)', () => {
	it('throws when called without caller context', async () => {
		await withTestHost(async (host) => {
			host.register(MikroOrmLibsql)
			host.setConfig('MikroOrm', { config: { dbName: ':memory:' } })
			await host.commitStrict()

			const mikro = host.getOrThrow(MikroOrm)
			await expect(
				mikro.registerEntity(UserSchema),
			).rejects.toThrow(/caller context/i)
		})
	})

	it('supports explicit scope without caller context', async () => {
		await withTestHost(async (host) => {
			host.register(MikroOrmLibsql)
			host.setConfig('MikroOrm', { config: { dbName: ':memory:', ensureSchemaOnInit: false } })
			await host.commitStrict()

			const mikro = host.getOrThrow(MikroOrm)
			const handle = await mikro.scope('Script').registerEntity(UserSchema)
			expect(handle.tableName).toBe('Script_users')
			expect(handle.entityName).toBe('Script_User')
			expect(await hasTable(mikro, 'Script_users')).toBe(true)
		})
	})

	it('registers entity and creates schema in :memory:', async () => {
		await withTestHost(async (host) => {
			host.register(MikroOrmLibsql)
			host.register(CallerA)
			host.setConfig('MikroOrm', { config: { dbName: ':memory:', ensureSchemaOnInit: true } })
			await host.commitStrict()

			const caller = host.getOrThrow(CallerA)
			const handle = await caller.registerUser()
			expect(handle.tableName).toBe('CallerA_users')
			expect(handle.entityName).toBe('CallerA_User')
			expect(handle.schema).not.toBe(UserSchema)

			const mikro = host.getOrThrow(MikroOrm)
			expect(await hasTable(mikro, 'CallerA_users')).toBe(true)
			expect(mikro.scope('CallerA').listEntities()).toEqual([
				{ entityName: 'CallerA_User', tableName: 'CallerA_users' },
			])
		})
	})

	it('drops table when handle disposed', async () => {
		await withTestHost(async (host) => {
			host.register(MikroOrmLibsql)
			host.register(CallerA)
			host.setConfig('MikroOrm', { config: { dbName: ':memory:' } })
			await host.commitStrict()

			const caller = host.getOrThrow(CallerA)
			const handle = await caller.registerUser({ dropTableOnDispose: true })

			const mikro = host.getOrThrow(MikroOrm)
			expect(await hasTable(mikro, 'CallerA_users')).toBe(true)

			await handle.dispose()
			expect(await hasTable(mikro, 'CallerA_users')).toBe(false)
		})
	})

	it('throws on table name conflict across entities (default)', async () => {
		await withTestHost(async (host) => {
			host.register(MikroOrmLibsql)
			host.register(CallerA)
			host.setConfig('MikroOrm', { config: { dbName: ':memory:' } })
			await host.commitStrict()

			const caller = host.getOrThrow(CallerA)
			await caller.registerUser()
			await expect(caller.registerConflictUser()).rejects.toThrow(/table name conflict/i)
		})
	})

	it('prefixes tables by caller id (no cross-plugin collisions)', async () => {
		await withTestHost(async (host) => {
			host.register(MikroOrmLibsql)
			host.register(CallerA)
			host.register(CallerB)
			host.setConfig('MikroOrm', { config: { dbName: ':memory:' } })
			await host.commitStrict()

			await host.getOrThrow(CallerA).registerUser()
			await host.getOrThrow(CallerB).registerUser()

			const mikro = host.getOrThrow(MikroOrm)
			expect(await hasTable(mikro, 'CallerA_users')).toBe(true)
			expect(await hasTable(mikro, 'CallerB_users')).toBe(true)
		})
	})

	it('avoids caller prefix collisions after sanitization', async () => {
		await withTestHost(async (host) => {
			host.register(MikroOrmLibsql)
			host.register(CallerDash)
			host.register(CallerUnderscore)
			host.setConfig('MikroOrm', { config: { dbName: ':memory:' } })
			await host.commitStrict()

			const dash = await host.getOrThrow(CallerDash).registerUser()
			const under = await host.getOrThrow(CallerUnderscore).registerUser()

			expect(dash.tableName).toMatch(/^a_b_[0-9a-f]{6}_users$/)
			expect(under.tableName).toBe('a_b_users')

			const mikro = host.getOrThrow(MikroOrm)
			expect(await hasTable(mikro, dash.tableName)).toBe(true)
			expect(await hasTable(mikro, under.tableName)).toBe(true)
		})
	})

	it('isolates data across caller-prefixed tables', async () => {
		await withTestHost(async (host) => {
			host.register(MikroOrmLibsql)
			host.register(CallerA)
			host.register(CallerB)
			host.setConfig('MikroOrm', { config: { dbName: ':memory:' } })
			await host.commitStrict()

			await host.getOrThrow(CallerA).registerUser()
			await host.getOrThrow(CallerB).registerUser()

			const mikro = host.getOrThrow(MikroOrm)
			await insertUserRow(mikro, 'CallerA_users', 1, 'a')
			await insertUserRow(mikro, 'CallerB_users', 2, 'b')

			expect(await listUserIds(mikro, 'CallerA_users')).toEqual([1])
			expect(await listUserIds(mikro, 'CallerB_users')).toEqual([2])
		})
	})

	it('supports ensureSchema=false and manual ensureSchema()', async () => {
		await withTestHost(async (host) => {
			host.register(MikroOrmLibsql)
			host.register(CallerA)
			host.setConfig('MikroOrm', { config: { dbName: ':memory:', ensureSchemaOnInit: false } })
			await host.commitStrict()

			await host.getOrThrow(CallerA).registerUser({ ensureSchema: false })

			const mikro = host.getOrThrow(MikroOrm)
			expect(await hasTable(mikro, 'CallerA_users')).toBe(false)

			await mikro.ensureSchema()
			expect(await hasTable(mikro, 'CallerA_users')).toBe(true)
		})
	})

	it('uses immediate caller id in layered plugin calls', async () => {
		await withTestHost(async (host) => {
			host.register(MikroOrmLibsql)
			host.register(Wrapper)
			host.register(Outer)
			host.setConfig('MikroOrm', { config: { dbName: ':memory:' } })
			await host.commitStrict()

			await host.getOrThrow(Outer).registerUserViaWrapper()

			const mikro = host.getOrThrow(MikroOrm)
			expect(await hasTable(mikro, 'Wrapper_users')).toBe(true)
			expect(await hasTable(mikro, 'Outer_users')).toBe(false)
		})
	})

	it('supports libsql in-memory url: file::memory:', async () => {
		await withTestHost(async (host) => {
			host.register(MikroOrmLibsql)
			host.register(CallerA)
			host.setConfig('MikroOrm', { config: { dbName: 'file::memory:', ensureSchemaOnInit: false } })
			await host.commitStrict()

			await host.getOrThrow(CallerA).registerUser()

			const mikro = host.getOrThrow(MikroOrm)
			const tables = (await listTables(mikro)).map((r) => r.name)
			expect(tables).toContain('CallerA_users')
		})
	})

	it('can restart the service (initPromise resets)', async () => {
		await withTestHost(async (host) => {
			host.register(MikroOrmLibsql)
			host.setConfig('MikroOrm', { config: { dbName: ':memory:' } })
			await host.commitStrict()

			host.restart(MikroOrm)
			await host.commitStrict()

			const mikro = host.getOrThrow(MikroOrm)
			const rows = await (await mikro.orm()).em.getConnection().execute('select 1 as ok')
			expect(Array.isArray(rows) && rows[0]?.ok).toBe(1)
		})
	})
})
