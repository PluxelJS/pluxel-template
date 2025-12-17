import { EntitySchema, MikroORM } from '@mikro-orm/libsql'

const UserSchema = new EntitySchema({
	name: 'User',
	tableName: 'users',
	properties: {
		id: { primary: true, type: 'number' },
		name: { type: 'string' },
	},
})

const orm = await MikroORM.init({
	dbName: ':memory:',
	entities: [],
	discovery: { warnWhenNoEntities: false },
})

orm.discoverEntity(UserSchema)
await orm.schema.updateSchema({ safe: true })

const before = await orm.em.getConnection().execute(
	"select name from sqlite_master where type='table' and name='users'",
)
if (!Array.isArray(before) || before.length !== 1) {
	throw new Error(`expected users table to exist, got: ${JSON.stringify(before)}`)
}

await orm.em.getConnection().execute('drop table if exists "users"')

const after = await orm.em.getConnection().execute(
	"select name from sqlite_master where type='table' and name='users'",
)
if (!Array.isArray(after) || after.length !== 0) {
	throw new Error(`expected users table to be dropped, got: ${JSON.stringify(after)}`)
}

await orm.close(true)
console.log('[mikro-orm selftest] ok')
