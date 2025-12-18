import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EntitySchema, MikroORM } from '@mikro-orm/core'
import { Config, Plugin } from '@pluxel/hmr'
import { v } from '@pluxel/hmr/config'
import { MikroOrm, MikroOrmProvider } from './core.js'

type LibsqlMikroORM = typeof import('@mikro-orm/libsql').MikroORM
type LibsqlInitOptions = NonNullable<Parameters<LibsqlMikroORM['init']>[0]>

export const MikroOrmConfigSchema = v.object({
	/** sqlite 文件路径；libsql 也支持 file/https/libsql:// 形式 */
	dbName: v.optional(v.string(), './data/pluxel.sqlite'),
	/** libsql token（可选） */
	authToken: v.optional(v.string()),
	debug: v.optional(v.boolean(), false),
	/** 默认 true：启动后会根据已注册实体创建表 */
	ensureSchemaOnInit: v.optional(v.boolean(), true),
	/** 原样 merge 到 MikroORM.init options（用于开启缓存、migrations 等高级能力） */
	mikroOptions: v.optional(v.record(v.string(), v.any()), {}),
})

type MikroOrmLibsqlConfig = Config<typeof MikroOrmConfigSchema>

let LIBSQL_ORM: Promise<{ MikroORM: typeof import('@mikro-orm/libsql').MikroORM }> | undefined
async function importLibsqlOrm() {
	LIBSQL_ORM ??= import('@mikro-orm/libsql')
	return LIBSQL_ORM
}

@Plugin(MikroOrm, { name: 'MikroOrm', type: 'service' })
export class MikroOrmLibsql extends MikroOrmProvider<MikroOrmLibsqlConfig> {
	@Config(MikroOrmConfigSchema)
	private config!: MikroOrmLibsqlConfig

	protected override readConfig(): MikroOrmLibsqlConfig {
		return v.parse(MikroOrmConfigSchema, (this.config as unknown) ?? {})
	}

	protected override async createOrm(
		config: MikroOrmLibsqlConfig,
		entities: EntitySchema<any>[],
	): Promise<MikroORM> {
		const { MikroORM } = await importLibsqlOrm()
		const dbName = resolveDbName(config.dbName)
		await ensureDbDir(dbName)

		const extra = { ...(config.mikroOptions ?? {}) } as Record<string, unknown>
		const { discovery: discoveryExtra, ...restExtra } = extra as { discovery?: unknown } & Record<
			string,
			unknown
		>
		const discovery = {
			warnWhenNoEntities: false,
			...(isRecord(discoveryExtra) ? discoveryExtra : {}),
		} as NonNullable<LibsqlInitOptions['discovery']>

		this.ctx.logger.info(`[MikroOrm] init (db=${dbName})`)
		const initOptions: LibsqlInitOptions = {
			...(restExtra as Partial<LibsqlInitOptions>),
			dbName,
			password: config.authToken,
			entities,
			debug: config.debug,
			discovery,
		} as LibsqlInitOptions
		const orm = await MikroORM.init(initOptions)

		if (config.ensureSchemaOnInit) {
			await orm.schema.updateSchema({ safe: true })
		}

		return orm
	}
}

function resolveDbName(dbName: string): string {
	// 对相对路径做 normalize，避免 cwd 变化带来的问题
	if (dbName === ':memory:') return dbName
	// 远端 libsql 以及 http(s) 直连都保留原值
	if (dbName.startsWith('libsql:') || dbName.startsWith('http://') || dbName.startsWith('https://')) {
		return dbName
	}

	// 标准 file URL（file://...）：转换成真实文件路径，便于 mkdir/日志/一致性
	// 注意：libsql 的 sqlite-uri 形式也用 `file:`（如 `file::memory:`），但不是标准 URL，不能 fileURLToPath。
	if (dbName.startsWith('file://')) {
		return fileURLToPath(dbName)
	}
	// libsql/sqlite URI（file:xxx / file::memory: / file:memdb1?mode=memory...）保留原样
	if (dbName.startsWith('file:')) return dbName

	return path.isAbsolute(dbName) ? dbName : path.join(process.cwd(), dbName)
}

async function ensureDbDir(dbName: string): Promise<void> {
	if (dbName === ':memory:') return
	// libsql://xxx / http(s) / file:xxx (libsql sqlite-uri) 都不需要在这里 mkdir
	if (dbName.startsWith('libsql:')) return
	if (dbName.startsWith('http://') || dbName.startsWith('https://')) return
	if (dbName.startsWith('file:')) return
	await mkdir(path.dirname(dbName), { recursive: true })
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}
