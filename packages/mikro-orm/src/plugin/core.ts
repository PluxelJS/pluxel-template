import { EntitySchema } from '@mikro-orm/core'
import type {
	Constructor,
	DeepPartial,
	EntityManager,
	EntityMetadata,
	ForkOptions,
	MikroORM,
	Options,
	UpdateSchemaOptions,
} from '@mikro-orm/core'
import type { SqlEntityManager } from '@mikro-orm/knex'
import { BasePlugin } from '@pluxel/hmr'
import { createHash } from 'node:crypto'

export type UseEntityOptions = {
	/** 默认 true：首次注册后自动建表/补列（safe） */
	ensureSchema?: boolean
	/** 默认 false：注销时 DROP TABLE（谨慎开启） */
	dropTableOnDispose?: boolean

	/**
	 * 覆盖“基础表名”（不含 caller 前缀）。
	 *
	 * 规则（不可配置）：
	 * - caller 必须存在（必须在插件内调用；不要在宿主/脚本里直接调用 service 方法）。
	 * - 实际表名恒为：`${callerId}_${tableName}`（分隔符固定 `_`）。
	 *
	 * 备注：
	 * - 这里传入的是“基础表名”，不是完整表名；即使你传了 `${callerId}_xxx` 也会被归一化处理。
	 */
	tableName?: string
}

export interface MikroOrmEntityHandle {
	/** MikroORM 内部使用的实体名（会被 caller 前缀化）。 */
	entityName: string
	/** 实际表名（恒带 caller 前缀）。 */
	tableName: string
	/** 实际注册进 ORM 的 schema（可能是内部 clone；建议用它做后续查询）。 */
	schema: EntitySchema<any>
	dispose: () => Promise<void>
}

export interface MikroOrmEntitiesHandle {
	entities: MikroOrmEntityHandle[]
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
	 * 注意：`tableName` 会自动按 caller 前缀隔离（避免跨插件冲突）。
	 */
	migrations?: Partial<Options['migrations']>
}

/**
 * 抽象 token：用于依赖注入（多实现插件模式）。
 * 默认 provider 为 `MikroOrmLibsql`（id 为 `MikroOrm`）。
 *
 * 设计目标：尽量暴露原生 MikroORM/EntityManager，而不是再造一套查询 API。
 */
export abstract class MikroOrm extends BasePlugin {
	/** 底层 MikroORM 实例（migrations/cache/schema 等高级能力直接用它）。 */
	abstract orm(): Promise<MikroORM>

	/**
	 * 串行执行（用于 discover/reset entity、更新 schema 等需要避免并发的操作）。
	 * 注意：普通查询不要放进 exclusive；直接用 `orm().em.fork()` 并发即可。
	 */
	abstract exclusive<T>(fn: (orm: MikroORM) => T | Promise<T>): Promise<T>

	abstract listEntities(): Array<{ entityName: string; tableName: string }>

	/**
	 * 注册一个 EntitySchema（按 caller 隔离，避免跨插件表名冲突）。
	 *
	 * 重要语义：
	 * - caller = 直接注入并调用本 service 的那个插件。
	 * - 如果你写了一个“包装插件”去转发 MikroOrm 给别的插件，那么 caller 会是包装插件；
	 *   想要“谁用谁的表”，就让目标插件直接依赖 MikroOrm。
	 *
	 * 返回值里的 `handle.schema` 是实际 discover 进 MikroORM 的 schema；推荐后续查询使用它，
	 * 这样即便不同插件复用同一个输入 schema，也不会互相污染/冲突。
	 */
	abstract useEntity(
		schema: EntitySchema<any>,
		options?: UseEntityOptions,
	): Promise<MikroOrmEntityHandle>

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
	 * 批量注册：默认只在最后做一次 `updateSchema({ safe: true })`，避免多次 diff。
	 * 返回一个可 dispose 的 handle，默认也会绑定到 caller scope。
	 */
	async useEntities(
		schemas: EntitySchema<any>[],
		options: UseEntityOptions = {},
	): Promise<MikroOrmEntitiesHandle> {
		const ensure = options.ensureSchema ?? true
		const perEntity = ensure ? { ...options, ensureSchema: false } : options
		const handles: MikroOrmEntityHandle[] = []
		for (const schema of schemas) {
			handles.push(await this.useEntity(schema, perEntity))
		}
		if (ensure) {
			await this.ensureSchema()
		}
		return {
			entities: handles,
			dispose: async () => {
				await Promise.all(handles.map((h) => h.dispose()))
			},
		}
	}

	/**
	 * 动态 discover entity（支持 class 或 EntitySchema）。
	 * reset 用于移除已存在的 metadata（参见 MikroORM.discoverEntity 的 reset 参数）。
	 */
	async discoverEntity(
		...args: Parameters<MikroORM['discoverEntity']>
	): Promise<void> {
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

	/**
	 * 以 caller 为作用域执行 migrations（用 caller 前缀隔离 migrations table，避免跨插件冲突）。
	 *
	 * 说明：
	 * - 不引入硬依赖；如未安装 `@mikro-orm/migrations` 会抛出清晰错误。
	 * - migrations 的具体行为/参数由 MikroORM 版本决定；此处只做“作用域隔离 + 安全封装”。
	 */
	async migrate(options: MikroOrmMigrateOptions = {}): Promise<void> {
		const callerId = this.ctx.caller?.pluginInfo?.id
		if (!callerId) {
			throw new Error('[MikroOrm] migrate() requires caller context (call it inside a plugin)')
		}

		const direction = options.direction ?? 'up'
		const prefix = callerPrefix(callerId)

		await this.exclusive(async (orm) => {
			const prev = orm.config.get('migrations')
			try {
				const next = { ...prev, ...(options.migrations ?? {}) }
				const baseTable = String(next.tableName ?? 'mikro_orm_migrations')
				next.tableName = `${prefix}_${stripPrefix(baseTable, prefix)}`
				orm.config.set('migrations', next)

				// Accessing `orm.migrator` triggers optional dependency loading.
				// If not installed, MikroORM throws with an install hint.
				if (direction === 'down') {
					await orm.migrator.down()
				} else {
					await orm.migrator.up()
				}
			} finally {
				// Restore config even if migrator throws.
				orm.config.set('migrations', prev)
			}
		})
	}
}

type RegisteredEntity = {
	callerId: string
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
		const root = (this.ctx as unknown as { root: object }).root
		return getShared<C>(root, this.ctx.pluginInfo.id)
	}

	override async init(_abort?: AbortSignal): Promise<void> {
		const shared = this.shared()
		shared.initPromise ??= shared.opQueue.run(async () => {
			shared.config = this.readConfig()
			shared.ormInstance = await this.createOrm(shared.config, [...shared.entities.values()].map((e) => e.schema))

			const instance = shared.ormInstance
			const cancel = this.ctx.scope.collectEffect(() => void instance?.close(true))
			if (typeof cancel === 'function') shared.ormCloseCancels.add(cancel)

			this.ctx.logger.info(`[MikroOrm] ready`)
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
			shared.entities.clear()
			shared.tableToEntityName.clear()
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

	override listEntities(): Array<{ entityName: string; tableName: string }> {
		return [...this.shared().entities.values()].map((e) => ({
			entityName: e.entityName,
			tableName: e.tableName,
		}))
	}

	override async useEntity(schema: EntitySchema<any>, options: UseEntityOptions = {}): Promise<MikroOrmEntityHandle> {
		const shared = this.shared()
		const callerId = this.ctx.caller?.pluginInfo?.id
		if (!callerId) {
			throw new Error(
				'[MikroOrm] useEntity() requires caller context (inject MikroOrm into a plugin and call it there)',
			)
		}

		const prefix = callerPrefix(callerId)
		const baseEntityName = stripPrefix(resolveEntityName(schema), prefix)
		const baseTableName = stripPrefix(resolveTableName(schema, options), prefix)
		const entityName = `${prefix}_${baseEntityName}`
		const tableName = `${prefix}_${baseTableName}`
		const ensureSchema = options.ensureSchema ?? true

		return await this.exclusive(async (orm) => {
			const existing = shared.entities.get(entityName)
			if (existing && existing.callerId !== callerId) {
				throw new Error(
					`[MikroOrm] entity conflict: "${entityName}" is already registered by "${existing.callerId}"`,
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
					callerId,
					entityName,
					baseEntityName,
					baseTableName,
					schema: effective,
					tableName,
					dropTableOnDispose,
				}
				const handle = new EntityHandleImpl(
					() => this.releaseEntity(rec.entityName, rec.callerId),
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
				return handle
			}

			if (existing.tableName !== tableName) {
				shared.tableToEntityName.delete(existing.tableName)
				shared.tableToEntityName.set(tableName, entityName)
			}

			existing.baseEntityName = baseEntityName
			existing.baseTableName = baseTableName
			existing.schema = effective
			existing.tableName = tableName
			existing.dropTableOnDispose = dropTableOnDispose

			orm.discoverEntity(effective, entityName)
			if (ensureSchema) await orm.schema.updateSchema({ safe: true })
			return existing.handle!
		})
	}

	protected async releaseEntity(entityName: string, callerId: string): Promise<void> {
		const shared = this.shared()
		await shared.opQueue.run(async () => {
			const rec = shared.entities.get(entityName)
			if (!rec) return
			if (rec.callerId !== callerId) return

			shared.entities.delete(entityName)
			shared.tableToEntityName.delete(rec.tableName)

			const orm = shared.ormInstance
			if (!orm) return

			orm.discoverEntity([], entityName)

			if (rec.dropTableOnDispose) {
				await this.dropTableIfExists(orm, rec.tableName)
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
	return schema.meta.className
}

function resolveTableName(schema: EntitySchema<any>, options: UseEntityOptions): string {
	return String(options.tableName ?? schema.meta.tableName)
}

function callerPrefix(input: string): string {
	const raw = input.trim()
	const sanitized = raw.replace(/[^a-zA-Z0-9_]+/g, '_') || 'caller'
	// Avoid collisions when sanitization changes the id (e.g. `a-b` vs `a_b`).
	if (sanitized === raw && /^[a-zA-Z0-9_]+$/.test(raw)) return raw
	const hash = createHash('sha1').update(raw).digest('hex').slice(0, 6)
	return `${sanitized}_${hash}`
}

function stripPrefix(value: string, prefix: string): string {
	const p = `${prefix}_`
	return value.startsWith(p) ? value.slice(p.length) : value
}

function rewriteSchema(input: EntitySchema<any>, entityName: string, tableName: string): EntitySchema<any> {
	// Always clone: callers may share the same EntitySchema instance across plugins.
	// We must not mutate the input schema (tableName/entityName are per-caller).
	//
	// Important: `EntitySchema` constructor prefers `meta.class.name` over `meta.name`, so we must
	// drop `class/prototype` at the metadata level to prevent `discoverEntity()` from "snapping back".
	const meta: DeepPartial<EntityMetadata<any>> = {
		...input.meta,
		name: entityName,
		className: entityName,
		tableName,
		collection: tableName,
		class: undefined,
		prototype: undefined,
	}
	const effective = EntitySchema.fromMetadata(meta)
	effective.init()
	return effective
}

class EntityHandleImpl implements MikroOrmEntityHandle {
	private static readonly ASYNC_DISPOSE: unique symbol =
		(Symbol as any).asyncDispose ?? Symbol.for('Symbol.asyncDispose')

	private disposed = false

	constructor(
		private readonly disposeFn: () => Promise<void>,
		private readonly rec: RegisteredEntity,
		private readonly onDisposeError: (err: unknown, entityName: string) => void,
	) {
		;(this as any)[EntityHandleImpl.ASYNC_DISPOSE] = () => this.dispose()
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
