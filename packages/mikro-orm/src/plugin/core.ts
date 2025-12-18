import { createHash } from 'node:crypto'
import type {
	DeepPartial,
	EntityManager,
	EntityMetadata,
	ForkOptions,
	MikroORM,
	Options,
	UpdateSchemaOptions,
} from '@mikro-orm/core'
import { EntitySchema } from '@mikro-orm/core'
import type { SqlEntityManager } from '@mikro-orm/knex'
import { BasePlugin } from '@pluxel/hmr'

export type MikroOrmScopeKey = string

export type RegisterEntityOptions = {
	/** 默认 true：首次注册后自动建表/补列（safe） */
	ensureSchema?: boolean
	/** 默认 false：注销时 DROP TABLE（谨慎开启） */
	dropTableOnDispose?: boolean

	/**
	 * 覆盖“基础实体名”（不含 scope 前缀）。
	 *
	 * 备注：
	 * - 这里传入的是“基础实体名”，不是完整实体名；即使你传了 `${scopePrefix}_xxx` 也会被归一化处理。
	 */
	entityName?: string

	/**
	 * 覆盖“基础表名”（不含 scope 前缀）。
	 *
	 * 规则（不可配置）：
	 * - scope = caller 插件 id（当你在插件内通过 DI 注入 MikroOrm 并调用时自动提供）
	 * - 实际表名恒为：`${scopePrefix}_${tableName}`（分隔符固定 `_`）。
	 *
	 * 备注：
	 * - 这里传入的是“基础表名”，不是完整表名；即使你传了 `${scopePrefix}_xxx` 也会被归一化处理。
	 */
	tableName?: string
}

export interface MikroOrmEntity<T extends object = any> {
	scopeKey: MikroOrmScopeKey
	scopePrefix: string
	baseEntityName: string
	baseTableName: string
	entityName: string
	tableName: string
	schema: EntitySchema<T>
	dispose: () => Promise<void>
}

export interface MikroOrmEntityBatch {
	entities: MikroOrmEntity[]
	dispose: () => Promise<void>
}

export type MikroOrmMigrateOptions = {
	/**
	 * 默认 `up`。
	 * - `up`: 执行未运行的 migration
	 * - `down`: 回滚（由 MikroORM/migrations 具体实现决定参数）
	 */
	direction?: 'up' | 'down'

	/**
	 * 传给 MikroORM 的 `migrations` 配置（会与当前配置 merge）。
	 * 注意：`tableName` 会自动按 scope 前缀隔离（避免跨插件冲突）。
	 */
	migrations?: Partial<Options['migrations']>
}

export interface MikroOrmScope {
	key: MikroOrmScopeKey
	prefix: string

	orm: () => Promise<MikroORM>
	em: (options?: ForkOptions) => Promise<EntityManager>
	sqlEm: (options?: ForkOptions) => Promise<SqlEntityManager>

	listEntities: () => Array<{ entityName: string; tableName: string }>

	registerEntity: <T extends object>(
		schema: EntitySchema<T>,
		options?: RegisterEntityOptions,
	) => Promise<MikroOrmEntity<T>>

	registerEntities: (
		schemas: EntitySchema<any>[],
		options?: RegisterEntityOptions,
	) => Promise<MikroOrmEntityBatch>

	migrate: (options?: MikroOrmMigrateOptions) => Promise<void>
	ensureSchema: (options?: UpdateSchemaOptions) => Promise<void>
}

/**
 * 抽象 token：用于依赖注入（多实现插件模式）。
 * 默认 provider 为 `MikroOrmLibsql`（id 为 `MikroOrm`）。
 *
 * 设计目标：
 * - 暴露原生 MikroORM/EntityManager（不再造查询 API）
 * - 通过 `scope()` 明确 caller 隔离与可显式 scope（脚本/共享表/测试）
 */
export abstract class MikroOrm extends BasePlugin {
	/** 底层 MikroORM 实例（migrations/cache/schema 等高级能力直接用它）。 */
	abstract orm(): Promise<MikroORM>

	/**
	 * 串行执行（用于 discover/reset entity、更新 schema 等需要避免并发的操作）。
	 * 注意：普通查询不要放进 exclusive；直接用 `orm().em.fork()` 并发即可。
	 */
	abstract exclusive<T>(fn: (orm: MikroORM) => T | Promise<T>): Promise<T>

	/** 列出当前服务内所有 scope 的实体（用于调试/观测）。 */
	abstract listEntities(): Array<{ scopeKey: MikroOrmScopeKey; entityName: string; tableName: string }>

	protected abstract listEntitiesFor(
		scopeKey: MikroOrmScopeKey,
	): Array<{ entityName: string; tableName: string }>
	protected abstract scopePrefixFor(scopeKey: MikroOrmScopeKey): string
	protected abstract registerEntityFor<T extends object>(
		scopeKey: MikroOrmScopeKey,
		schema: EntitySchema<T>,
		options?: RegisterEntityOptions,
	): Promise<MikroOrmEntity<T>>
	protected abstract migrateFor(scopeKey: MikroOrmScopeKey, options?: MikroOrmMigrateOptions): Promise<void>

	/**
	 * Caller-scope 的快捷方法（最常用的插件→插件用法）。
	 * 等价于 `mikro.scope().registerEntity(...)`。
	 */
	async registerEntity<T extends object>(
		schema: EntitySchema<T>,
		options?: RegisterEntityOptions,
	): Promise<MikroOrmEntity<T>> {
		return await this.registerEntityFor(this.requireCallerScopeKey('registerEntity'), schema, options)
	}

	/**
	 * Caller-scope 的批量注册快捷方法。
	 * 等价于 `mikro.scope().registerEntities(...)`。
	 */
	async registerEntities(
		schemas: EntitySchema<any>[],
		options: RegisterEntityOptions = {},
	): Promise<MikroOrmEntityBatch> {
		const scopeKey = this.requireCallerScopeKey('registerEntities')
		const ensure = options.ensureSchema ?? true
		const perEntity = ensure ? { ...options, ensureSchema: false } : options

		const entities: MikroOrmEntity[] = []
		for (const schema of schemas) {
			entities.push(await this.registerEntityFor(scopeKey, schema, perEntity))
		}
		if (ensure) {
			await this.ensureSchema()
		}
		return {
			entities,
			dispose: async () => {
				await Promise.all(entities.map((e) => e.dispose()))
			},
		}
	}

	/** Caller-scope 下列出“本插件注册的实体”。 */
	listCallerEntities(): Array<{ entityName: string; tableName: string }> {
		return this.listEntitiesFor(this.requireCallerScopeKey('listCallerEntities'))
	}

	/** Caller-scope 下执行 migrations。 */
	async migrate(options?: MikroOrmMigrateOptions): Promise<void> {
		return await this.migrateFor(this.requireCallerScopeKey('migrate'), options)
	}

	/**
	 * 获取一个作用域视图。
	 * - `scope()`：使用“caller 插件”作为 scope（必须在插件内通过 DI 调用）
	 * - `scope('X')`：显式指定 scope（脚本/共享表/测试）
	 */
	scope(scopeKey?: MikroOrmScopeKey): MikroOrmScope {
		const key = scopeKey ?? this.requireCallerScopeKey('scope')
		const prefix = this.scopePrefixFor(key)
		const mikro = this

		return {
			key,
			prefix,
			orm: () => mikro.orm(),
			em: (options?: ForkOptions) => mikro.em(options),
			sqlEm: (options?: ForkOptions) => mikro.sqlEm(options),
			listEntities: () => mikro.listEntitiesFor(key),
			registerEntity: <T extends object>(schema: EntitySchema<T>, options?: RegisterEntityOptions) =>
				mikro.registerEntityFor<T>(key, schema, options),
			registerEntities: async (schemas: EntitySchema<any>[], options: RegisterEntityOptions = {}) => {
				const ensure = options.ensureSchema ?? true
				const perEntity = ensure ? { ...options, ensureSchema: false } : options

				const entities: MikroOrmEntity[] = []
				for (const schema of schemas) {
					entities.push(await mikro.registerEntityFor(key, schema, perEntity))
				}
				if (ensure) {
					await mikro.ensureSchema()
				}
				return {
					entities,
					dispose: async () => {
						await Promise.all(entities.map((e) => e.dispose()))
					},
				}
			},
			migrate: (options?: MikroOrmMigrateOptions) => mikro.migrateFor(key, options),
			ensureSchema: (options?: UpdateSchemaOptions) => mikro.ensureSchema(options),
		}
	}

	/** 等价于 `await orm()`，便于表达“确保已初始化”。 */
	async ready(): Promise<void> {
		await this.orm()
	}

	/** 默认返回一个 fork（隔离 identity map，适合并发请求/任务）。 */
	async em(options?: ForkOptions): Promise<EntityManager> {
		return (await this.orm()).em.fork(options)
	}

	/** SQL 场景的强类型 EntityManager（包含 `qb/execute/getKnex` 等能力）。 */
	async sqlEm(options?: ForkOptions): Promise<SqlEntityManager> {
		return (await this.em(options)) as unknown as SqlEntityManager
	}

	/**
	 * 动态 discover entity（支持 class 或 EntitySchema）。
	 * reset 用于移除已存在的 metadata（参见 MikroORM.discoverEntity 的 reset 参数）。
	 */
	async discoverEntity(...args: Parameters<MikroORM['discoverEntity']>): Promise<void> {
		await this.exclusive((orm) => {
			orm.discoverEntity(...args)
		})
	}

	/** 默认 safe=true：只创建/补列，避免运行时意外 drop。 */
	async ensureSchema(options: UpdateSchemaOptions = {}): Promise<void> {
		await this.exclusive(async (orm) => {
			await orm.schema.updateSchema({ safe: true, ...options })
		})
	}

	protected requireCallerScopeKey(method: string): MikroOrmScopeKey {
		const callerId = this.ctx.caller?.pluginInfo?.id
		if (!callerId) {
			throw new Error(`[MikroOrm] ${method}() requires caller context (call it inside a plugin)`)
		}
		return callerId
	}
}

type RegisteredEntity = {
	scopeKey: MikroOrmScopeKey
	scopePrefix: string
	entityName: string
	baseEntityName: string
	baseTableName: string
	schema: EntitySchema<any>
	tableName: string
	dropTableOnDispose: boolean
	handle?: EntityHandleImpl
}

type SharedState<C> = {
	config?: C
	ormInstance?: MikroORM
	initPromise?: Promise<void>
	ormCloseCancels: Set<() => void>
	opQueue: SerialQueue
	entities: Map<string, RegisteredEntity>
	tableToEntityName: Map<string, string>
	pendingDropTables: Set<string>
	scopePrefixCache: Map<string, string>
}

const SHARED_BY_ROOT = new WeakMap<object, Map<string, SharedState<any>>>()
function getShared<C>(root: object, id: string): SharedState<C> {
	let byId = SHARED_BY_ROOT.get(root)
	if (!byId) {
		byId = new Map()
		SHARED_BY_ROOT.set(root, byId)
	}

	let shared = byId.get(id)
	if (!shared) {
		shared = {
			ormCloseCancels: new Set(),
			opQueue: new SerialQueue(),
			entities: new Map(),
			tableToEntityName: new Map(),
			pendingDropTables: new Set(),
			scopePrefixCache: new Map(),
		}
		byId.set(id, shared)
	}
	return shared as SharedState<C>
}

export abstract class MikroOrmProvider<C> extends MikroOrm {
	protected abstract readConfig(): C
	protected abstract createOrm(config: C, entities: EntitySchema<any>[]): Promise<MikroORM>
	protected async closeOrm(orm: MikroORM): Promise<void> {
		await orm.close(true)
	}

	protected shared(): SharedState<C> {
		return getShared<C>(this.ctx.root, this.ctx.pluginInfo.id)
	}

	override async init(_abort?: AbortSignal): Promise<void> {
		const shared = this.shared()
		shared.initPromise ??= shared.opQueue.run(async () => {
			shared.config = this.readConfig()
			shared.ormInstance = await this.createOrm(
				shared.config,
				[...shared.entities.values()].map((e) => e.schema),
			)

			const instance = shared.ormInstance
			const cancel = this.ctx.scope.collectEffect(() => void instance?.close(true))
			if (typeof cancel === 'function') shared.ormCloseCancels.add(cancel)

			if (shared.pendingDropTables.size > 0) {
				const pending = [...shared.pendingDropTables]
				shared.pendingDropTables.clear()
				for (const tableName of pending) {
					try {
						await this.dropTableIfExists(instance, tableName)
					} catch (err) {
						this.ctx.logger.debug(err, `[MikroOrm] pending drop failed: ${tableName}`)
					}
				}
			}

			this.ctx.logger.info('[MikroOrm] ready')
		})
		try {
			await shared.initPromise
		} catch (err) {
			shared.initPromise = undefined
			throw err
		}
	}

	override async stop(_abort?: AbortSignal): Promise<void> {
		const shared = this.shared()
		await shared.opQueue.run(async () => {
			for (const cancel of shared.ormCloseCancels) {
				try {
					cancel()
				} catch {}
			}
			shared.ormCloseCancels.clear()
			if (shared.ormInstance) await this.closeOrm(shared.ormInstance)
			shared.config = undefined
			shared.ormInstance = undefined
			shared.initPromise = undefined
		})
		this.ctx.logger.info('[MikroOrm] stopped')
	}

	override async orm(): Promise<MikroORM> {
		await this.ensureReady()
		return this.shared().ormInstance!
	}

	override async exclusive<T>(fn: (orm: MikroORM) => T | Promise<T>): Promise<T> {
		await this.ensureReady()
		const shared = this.shared()
		return shared.opQueue.run(async () => fn(shared.ormInstance!))
	}

	override listEntities(): Array<{ scopeKey: MikroOrmScopeKey; entityName: string; tableName: string }> {
		return [...this.shared().entities.values()].map((e) => ({
			scopeKey: e.scopeKey,
			entityName: e.entityName,
			tableName: e.tableName,
		}))
	}

	protected override listEntitiesFor(
		scopeKey: MikroOrmScopeKey,
	): Array<{ entityName: string; tableName: string }> {
		return [...this.shared().entities.values()]
			.filter((e) => e.scopeKey === scopeKey)
			.map((e) => ({ entityName: e.entityName, tableName: e.tableName }))
	}

	protected override scopePrefixFor(scopeKey: MikroOrmScopeKey): string {
		return getScopePrefix(this.shared(), scopeKey)
	}

	protected override async registerEntityFor<T extends object>(
		scopeKey: MikroOrmScopeKey,
		schema: EntitySchema<T>,
		options: RegisterEntityOptions = {},
	): Promise<MikroOrmEntity<T>> {
		const shared = this.shared()
		const prefix = getScopePrefix(shared, scopeKey)

		const rawBaseEntityName = options.entityName ?? resolveEntityName(schema)
		const rawBaseTableName = options.tableName ?? resolveTableName(schema)

		const baseEntityName = stripPrefix(String(rawBaseEntityName), prefix)
		const baseTableName = stripPrefix(String(rawBaseTableName), prefix)

		const entityName = `${prefix}_${baseEntityName}`
		const tableName = `${prefix}_${baseTableName}`
		const ensureSchema = options.ensureSchema ?? true

		return await this.exclusive(async (orm) => {
			const existing = shared.entities.get(entityName)
			if (existing && existing.scopeKey !== scopeKey) {
				throw new Error(
					`[MikroOrm] entity conflict: "${entityName}" is already registered by "${existing.scopeKey}"`,
				)
			}

			const owner = shared.tableToEntityName.get(tableName)
			if (owner && owner !== entityName) {
				throw new Error(
					`[MikroOrm] table name conflict: table "${tableName}" is already used by entity "${owner}"`,
				)
			}

			const dropTableOnDispose = options.dropTableOnDispose ?? existing?.dropTableOnDispose ?? false
			const effective = rewriteSchema(schema, entityName, tableName)

			if (!existing) {
				const rec: RegisteredEntity = {
					scopeKey,
					scopePrefix: prefix,
					entityName,
					baseEntityName,
					baseTableName,
					schema: effective,
					tableName,
					dropTableOnDispose,
				}
				const handle = new EntityHandleImpl(
					() => this.releaseEntity(rec.entityName, rec.scopeKey),
					rec,
					(err, name) => {
						this.ctx.logger.debug(err, `[MikroOrm] dispose failed: ${name}`)
					},
				)
				rec.handle = handle

				shared.entities.set(entityName, rec)
				shared.tableToEntityName.set(tableName, entityName)

				const scope = this.ctx.caller?.scope ?? this.ctx.scope
				scope.collectEffect(() => handle.disposeSafe())

				orm.discoverEntity(effective)
				if (ensureSchema) await orm.schema.updateSchema({ safe: true })
				return handle as unknown as MikroOrmEntity<T>
			}

			if (existing.tableName !== tableName) {
				shared.tableToEntityName.delete(existing.tableName)
				shared.tableToEntityName.set(tableName, entityName)
			}

			existing.scopePrefix = prefix
			existing.baseEntityName = baseEntityName
			existing.baseTableName = baseTableName
			existing.schema = effective
			existing.tableName = tableName
			existing.dropTableOnDispose = dropTableOnDispose

			orm.discoverEntity(effective, entityName)
			if (ensureSchema) await orm.schema.updateSchema({ safe: true })
			return existing.handle! as unknown as MikroOrmEntity<T>
		})
	}

	protected override async migrateFor(
		scopeKey: MikroOrmScopeKey,
		options: MikroOrmMigrateOptions = {},
	): Promise<void> {
		const direction = options.direction ?? 'up'
		const prefix = this.scopePrefixFor(scopeKey)

		await this.exclusive(async (orm) => {
			const prev = orm.config.get('migrations')
			try {
				const next = { ...prev, ...(options.migrations ?? {}) }
				const baseTable = String(next.tableName ?? 'mikro_orm_migrations')
				next.tableName = `${prefix}_${stripPrefix(baseTable, prefix)}`
				orm.config.set('migrations', next)

				if (direction === 'down') {
					await orm.migrator.down()
				} else {
					await orm.migrator.up()
				}
			} finally {
				orm.config.set('migrations', prev)
			}
		})
	}

	protected async releaseEntity(entityName: string, scopeKey: MikroOrmScopeKey): Promise<void> {
		const shared = this.shared()
		await shared.opQueue.run(async () => {
			const rec = shared.entities.get(entityName)
			if (!rec) return
			if (rec.scopeKey !== scopeKey) return

			shared.entities.delete(entityName)
			shared.tableToEntityName.delete(rec.tableName)

			const orm = shared.ormInstance
			if (orm) {
				orm.discoverEntity([], entityName)
				if (rec.dropTableOnDispose) {
					await this.dropTableIfExists(orm, rec.tableName)
				}
			} else if (rec.dropTableOnDispose) {
				shared.pendingDropTables.add(rec.tableName)
			}
		})
	}

	protected async ensureReady(): Promise<void> {
		await this.init()
		if (!this.shared().ormInstance) throw new Error('[MikroOrm] orm not initialized')
	}

	protected async dropTableIfExists(orm: MikroORM, tableName: string): Promise<void> {
		const q = orm.em.getPlatform().quoteIdentifier(tableName)
		await orm.em.getConnection().execute(`drop table if exists ${q}`)
	}
}

function resolveEntityName(schema: EntitySchema<any>): string {
	const name = schema.meta.className ?? schema.meta.name
	if (!name) throw new Error('[MikroOrm] invalid EntitySchema: missing name/className')
	return String(name)
}

function resolveTableName(schema: EntitySchema<any>): string {
	const name = schema.meta.tableName ?? schema.meta.collection
	if (!name) throw new Error('[MikroOrm] invalid EntitySchema: missing tableName/collection')
	return String(name)
}

function scopePrefix(input: string): string {
	const raw = input.trim()
	const sanitized = raw.replace(/[^a-zA-Z0-9_]+/g, '_') || 'caller'
	if (sanitized === raw && /^[a-zA-Z0-9_]+$/.test(raw)) return raw
	const hash = createHash('sha1').update(raw).digest('hex').slice(0, 6)
	return `${sanitized}_${hash}`
}

function getScopePrefix(shared: SharedState<any>, scopeKey: MikroOrmScopeKey): string {
	const cached = shared.scopePrefixCache.get(scopeKey)
	if (cached) return cached
	const next = scopePrefix(scopeKey)
	shared.scopePrefixCache.set(scopeKey, next)
	return next
}

function stripPrefix(value: string, prefix: string): string {
	const p = `${prefix}_`
	return value.startsWith(p) ? value.slice(p.length) : value
}

function rewriteSchema<T extends object>(
	input: EntitySchema<T>,
	entityName: string,
	tableName: string,
): EntitySchema<T> {
	const meta = {
		...input.meta,
		name: entityName,
		className: entityName,
		tableName,
		collection: tableName,
	} as any
	delete meta.class
	delete meta.prototype

	const effective = EntitySchema.fromMetadata<T>(meta as EntityMetadata<T> | DeepPartial<EntityMetadata<T>>)
	effective.init()
	return effective as EntitySchema<T>
}

class EntityHandleImpl implements MikroOrmEntity {
	private static readonly ASYNC_DISPOSE: unique symbol =
		(Symbol as any).asyncDispose ?? Symbol.for('Symbol.asyncDispose')
	private static readonly DISPOSE: unique symbol = (Symbol as any).dispose ?? Symbol.for('Symbol.dispose')

	private disposed = false

	constructor(
		private readonly disposeFn: () => Promise<void>,
		private readonly rec: RegisteredEntity,
		private readonly onDisposeError: (err: unknown, entityName: string) => void,
	) {
		;(this as any)[EntityHandleImpl.ASYNC_DISPOSE] = () => this.dispose()
		;(this as any)[EntityHandleImpl.DISPOSE] = () => {
			void this.dispose()
		}
	}

	get scopeKey() {
		return this.rec.scopeKey
	}

	get scopePrefix() {
		return this.rec.scopePrefix
	}

	get baseEntityName() {
		return this.rec.baseEntityName
	}

	get baseTableName() {
		return this.rec.baseTableName
	}

	get entityName() {
		return this.rec.entityName
	}

	get tableName() {
		return this.rec.tableName
	}

	get schema(): EntitySchema<any> {
		return this.rec.schema
	}

	disposeSafe() {
		void this.dispose().catch((err) => {
			this.onDisposeError(err, this.entityName)
		})
	}

	async dispose(): Promise<void> {
		if (this.disposed) return
		this.disposed = true
		await this.disposeFn()
	}
}

class SerialQueue {
	private tail: Promise<unknown> = Promise.resolve()
	private depth = 0

	run<T>(fn: () => Promise<T>): Promise<T> {
		// 允许在队列执行中承接“嵌套 run”，避免自我等待造成死锁
		if (this.depth > 0) return fn()

		const wrapped = async () => {
			this.depth++
			try {
				return await fn()
			} finally {
				this.depth--
			}
		}

		const next = this.tail.then(wrapped, wrapped)
		this.tail = next.then(
			() => undefined,
			() => undefined,
		)
		return next
	}
}
