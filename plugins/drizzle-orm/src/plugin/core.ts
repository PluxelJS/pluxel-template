import { createHash } from 'node:crypto'
import type { Client, InArgs, InStatement, ResultSet } from '@libsql/client'
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql'
import type { DrizzleConfig } from 'drizzle-orm'
import type { MigrationConfig } from 'drizzle-orm/migrator'
import { migrate as migrateLibsql } from 'drizzle-orm/libsql/migrator'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import { getTableName } from 'drizzle-orm/table'
import { getTableConfig } from 'drizzle-orm/sqlite-core/utils'
import { BasePlugin } from '@pluxel/hmr'

export type DrizzleOrmScopeKey = string

export type RegisterTableOptions = {
	/** 默认 true：首次注册后自动建表/补列（safe） */
	ensureSchema?: boolean
	/** 默认 false：注销时 DROP TABLE（谨慎开启） */
	dropTableOnDispose?: boolean

	/**
	 * 覆盖“基础表名”（不含 scope 前缀）。
	 *
	 * 规则（不可配置）：
	 * - scope = caller 插件 id（当你在插件内通过 DI 注入 DrizzleOrm 并调用时自动提供）
	 * - 实际表名恒为：`${scopePrefix}_${tableName}`（分隔符固定 `_`）。
	 */
	tableName?: string
}

export type DrizzleOrmTableHandle<TTable extends SQLiteTable = SQLiteTable> = {
	scopeKey: DrizzleOrmScopeKey
	scopePrefix: string
	baseTableName: string
	tableName: string
	table: TTable
	dispose: () => Promise<void>
}

export type DrizzleOrmTableBatch = {
	tables: DrizzleOrmTableHandle[]
	dispose: () => Promise<void>
}

export interface DrizzleOrmScope {
	key: DrizzleOrmScopeKey
	prefix: string

	db: () => Promise<LibSQLDatabase<any>>
	dbWithSchema: <TSchema extends Record<string, unknown>>(
		schema: TSchema,
		config?: Omit<DrizzleConfig<TSchema>, 'schema' | 'connection' | 'client'>,
	) => Promise<LibSQLDatabase<TSchema>>
	client: () => Promise<Client>

	tableName: (baseTableName: string) => string

	registerTable: <TTable extends SQLiteTable>(
		factory: DrizzleOrmTableFactory<TTable>,
		options?: RegisterTableOptions,
	) => Promise<DrizzleOrmTableHandle<TTable>>

	registerTables: (
		factories: Array<DrizzleOrmTableFactory>,
		options?: RegisterTableOptions,
	) => Promise<DrizzleOrmTableBatch>

	migrate: (options?: DrizzleOrmMigrateOptions) => Promise<void>
}

export type DrizzleOrmTableFactory<TTable extends SQLiteTable = SQLiteTable> = ((
	tableName: string,
) => TTable) & {
	/** Optional base table name used for scoped prefixing when options.tableName is not provided. */
	baseName?: string
}

export function tableFactory<TTable extends SQLiteTable>(
	baseName: string,
	factory: (tableName: string) => TTable,
): DrizzleOrmTableFactory<TTable> {
	const fn = ((tableName: string) => factory(tableName)) as DrizzleOrmTableFactory<TTable>
	fn.baseName = baseName
	return fn
}

export type DrizzleOrmMigrateOptions = {
	/**
	 * Drizzle migrations config. `migrationsFolder` is required.
	 * `migrationsTable` will be auto-prefixed by scope (if present).
	 */
	migrations?: {
		migrationsFolder: string
		migrationsTable?: string
		migrationsSchema?: string
	}
}

/**
 * 抽象 token：用于依赖注入（多实现插件模式）。
 * 默认 provider 为 `DrizzleOrmLibsql`（id 为 `DrizzleOrm`）。
 *
 * 设计目标：
 * - 固定 Drizzle(sqlite) + libsql 的组合，减少抽象层
 * - 暴露原生 `drizzle-orm/libsql` 的 db（查询/事务）
 * - 通过 `scope()` 和 `registerTable()` 提供 MikroOrm 风格的表隔离 + 动态注册 + 运行时建表/补列
 */
export abstract class DrizzleOrm extends BasePlugin {
	abstract client(): Promise<Client>
	abstract db(): Promise<LibSQLDatabase<any>>

	/**
	 * 串行执行（用于 register/ensure/drop 等 DDL 操作）。
	 * 注意：普通查询不要放进 exclusive；直接并发用 drizzle db 即可。
	 */
	abstract exclusive<T>(fn: () => Promise<T>): Promise<T>

	abstract listTables(): Array<{ scopeKey: DrizzleOrmScopeKey; tableName: string }>
	abstract ensureSchema(): Promise<void>
	abstract migrate(options?: DrizzleOrmMigrateOptions): Promise<void>

	protected abstract listTablesFor(scopeKey: DrizzleOrmScopeKey): Array<{ tableName: string }>
	protected abstract scopePrefixFor(scopeKey: DrizzleOrmScopeKey): string
	protected abstract registerTableFor<TTable extends SQLiteTable>(
		scopeKey: DrizzleOrmScopeKey,
		factory: DrizzleOrmTableFactory<TTable>,
		options?: RegisterTableOptions,
	): Promise<DrizzleOrmTableHandle<TTable>>
	protected abstract migrateFor(scopeKey: DrizzleOrmScopeKey, options: DrizzleOrmMigrateOptions): Promise<void>

	async execute(stmt: InStatement): Promise<ResultSet>
	async execute(sql: string, args?: InArgs): Promise<ResultSet>
	async execute(stmtOrSql: InStatement | string, args?: InArgs): Promise<ResultSet> {
		const c = await this.client()
		return typeof stmtOrSql === 'string' ? await c.execute(stmtOrSql, args) : await c.execute(stmtOrSql)
	}

	async dbWithSchema<TSchema extends Record<string, unknown>>(
		schema: TSchema,
		config?: Omit<DrizzleConfig<TSchema>, 'schema' | 'connection' | 'client'>,
	): Promise<LibSQLDatabase<TSchema>> {
		const client = await this.client()
		return drizzle(client, { schema, ...(config ?? {}) })
	}

	/**
	 * Caller-scope 的快捷方法（最常用的插件→插件用法）。
	 * 等价于 `drizzle.scope().registerTable(...)`。
	 */
	async registerTable<TTable extends SQLiteTable>(
		factory: DrizzleOrmTableFactory<TTable>,
		options?: RegisterTableOptions,
	): Promise<DrizzleOrmTableHandle<TTable>> {
		return await this.registerTableFor(this.requireCallerScopeKey('registerTable'), factory, options)
	}

	/**
	 * Caller-scope 的批量注册快捷方法。
	 * 等价于 `drizzle.scope().registerTables(...)`。
	 */
	async registerTables(
		factories: Array<DrizzleOrmTableFactory>,
		options: RegisterTableOptions = {},
	): Promise<DrizzleOrmTableBatch> {
		if (options.tableName && factories.length > 1) {
			throw new Error('[DrizzleOrm] registerTables: options.tableName cannot be used with multiple factories')
		}
		const scopeKey = this.requireCallerScopeKey('registerTables')
		const ensure = options.ensureSchema ?? true
		const perTable = ensure ? { ...options, ensureSchema: false } : options

		const tables: DrizzleOrmTableHandle[] = []
		for (const factory of factories) {
			tables.push(await this.registerTableFor(scopeKey, factory, perTable))
		}
		if (ensure) {
			await this.ensureSchema()
		}
		return {
			tables,
			dispose: async () => {
				await Promise.all(tables.map((t) => t.dispose()))
			},
		}
	}

	listCallerTables(): Array<{ tableName: string }> {
		return this.listTablesFor(this.requireCallerScopeKey('listCallerTables'))
	}

	/** Caller-scope table name helper. */
	tableName(baseTableName: string): string {
		return this.scope().tableName(baseTableName)
	}

	/** Caller-scope migrations. */
	async migrate(options?: DrizzleOrmMigrateOptions): Promise<void> {
		return await this.migrateFor(this.requireCallerScopeKey('migrate'), options ?? {})
	}

	/**
	 * 获取一个作用域视图。
	 * - `scope()`：使用“caller 插件”作为 scope（必须在插件内通过 DI 调用）
	 * - `scope('X')`：显式指定 scope（脚本/共享表/测试）
	 */
	scope(scopeKey?: DrizzleOrmScopeKey): DrizzleOrmScope {
		const key = scopeKey ?? this.requireCallerScopeKey('scope')
		const prefix = this.scopePrefixFor(key)
		const tableName = (base: string) => `${prefix}_${stripPrefix(String(base), prefix)}`

		return {
			key,
			prefix,
			db: () => this.db(),
			dbWithSchema: <TSchema extends Record<string, unknown>>(
				schema: TSchema,
				config?: Omit<DrizzleConfig<TSchema>, 'schema' | 'connection' | 'client'>,
			) => this.dbWithSchema(schema, config),
			client: () => this.client(),
			tableName,
			registerTable: <TTable extends SQLiteTable>(
				factory: DrizzleOrmTableFactory<TTable>,
				options?: RegisterTableOptions,
			) => this.registerTableFor<TTable>(key, factory, options),
			registerTables: async (factories, options: RegisterTableOptions = {}) => {
				if (options.tableName && factories.length > 1) {
					throw new Error(
						'[DrizzleOrm] registerTables: options.tableName cannot be used with multiple factories',
					)
				}
				const ensure = options.ensureSchema ?? true
				const perTable = ensure ? { ...options, ensureSchema: false } : options

				const tables: DrizzleOrmTableHandle[] = []
				for (const factory of factories) {
					tables.push(await this.registerTableFor(key, factory, perTable))
				}
				if (ensure) await this.ensureSchema()
				return {
					tables,
					dispose: async () => {
						await Promise.all(tables.map((t) => t.dispose()))
					},
				}
			},
			migrate: (options?: DrizzleOrmMigrateOptions) => this.migrateFor(key, options ?? {}),
		}
	}

	/** 默认 safe=true：只创建/补列；不会尝试危险的重建/改约束。 */
	abstract ensureSchema(): Promise<void>

	protected requireCallerScopeKey(method: string): DrizzleOrmScopeKey {
		const callerId = this.ctx.caller?.pluginInfo?.id
		if (!callerId) {
			throw new Error(`[DrizzleOrm] ${method}() requires caller context (call it inside a plugin)`)
		}
		return callerId
	}
}

type RegisteredTable = {
	scopeKey: DrizzleOrmScopeKey
	scopePrefix: string
	baseTableName: string
	tableName: string
	table: SQLiteTable
	dropTableOnDispose: boolean
	handle?: TableHandleImpl
}

type SharedState<C> = {
	config?: C
	client?: Client
	db?: LibSQLDatabase<any>
	initPromise?: Promise<void>
	closeCancels: Set<() => void>
	opQueue: SerialQueue
	tables: Map<string, RegisteredTable>
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
			closeCancels: new Set(),
			opQueue: new SerialQueue(),
			tables: new Map(),
			scopePrefixCache: new Map(),
		}
		byId.set(id, shared)
	}
	return shared as SharedState<C>
}

export abstract class DrizzleOrmProvider<C> extends DrizzleOrm {
	protected abstract readConfig(): C
	protected abstract createClient(config: C): Promise<Client>
	protected abstract createDb(client: Client, config: C): Promise<LibSQLDatabase<any>>

	protected shared(): SharedState<C> {
		return getShared<C>(this.ctx.root, this.ctx.pluginInfo.id)
	}

	override async init(_abort?: AbortSignal): Promise<void> {
		const shared = this.shared()
		shared.initPromise ??= shared.opQueue.run(async () => {
			shared.config = this.readConfig()
			shared.client = await this.createClient(shared.config)
			shared.db = await this.createDb(shared.client, shared.config)

			const client = shared.client
			const cancel = this.ctx.scope.collectEffect(() => void client?.close())
			if (typeof cancel === 'function') shared.closeCancels.add(cancel)

			this.ctx.logger.info('ready')
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
			for (const cancel of shared.closeCancels) {
				try {
					cancel()
				} catch {}
			}
			shared.closeCancels.clear()
			shared.client?.close()
			shared.config = undefined
			shared.client = undefined
			shared.db = undefined
			shared.initPromise = undefined
		})
		this.ctx.logger.info('stopped')
	}

	override async client(): Promise<Client> {
		await this.ensureReady()
		return this.shared().client!
	}

	override async db(): Promise<LibSQLDatabase<any>> {
		await this.ensureReady()
		return this.shared().db!
	}

	override async exclusive<T>(fn: () => Promise<T>): Promise<T> {
		await this.ensureReady()
		return await this.shared().opQueue.run(fn)
	}

	override listTables(): Array<{ scopeKey: DrizzleOrmScopeKey; tableName: string }> {
		return [...this.shared().tables.values()].map((t) => ({ scopeKey: t.scopeKey, tableName: t.tableName }))
	}

	protected override listTablesFor(scopeKey: DrizzleOrmScopeKey): Array<{ tableName: string }> {
		return [...this.shared().tables.values()]
			.filter((t) => t.scopeKey === scopeKey)
			.map((t) => ({ tableName: t.tableName }))
	}

	protected override scopePrefixFor(scopeKey: DrizzleOrmScopeKey): string {
		return getScopePrefix(this.shared(), scopeKey)
	}

	protected override async registerTableFor<TTable extends SQLiteTable>(
		scopeKey: DrizzleOrmScopeKey,
		factory: DrizzleOrmTableFactory<TTable>,
		options: RegisterTableOptions = {},
	): Promise<DrizzleOrmTableHandle<TTable>> {
		const shared = this.shared()
		const prefix = getScopePrefix(shared, scopeKey)

		const rawBaseTableName = options.tableName ?? factory.baseName
		if (!rawBaseTableName) {
			throw new Error('[DrizzleOrm] missing base table name: pass options.tableName or use tableFactory()')
		}
		const baseTableName = stripPrefix(String(rawBaseTableName), prefix)
		const tableName = `${prefix}_${baseTableName}`

		const ensureSchema = options.ensureSchema ?? true

		return await this.exclusive(async () => {
			const existing = shared.tables.get(tableName)
			if (existing && existing.scopeKey !== scopeKey) {
				throw new Error(
					`[DrizzleOrm] table name conflict: "${tableName}" is already registered by "${existing.scopeKey}"`,
				)
			}

			const dropTableOnDispose = options.dropTableOnDispose ?? existing?.dropTableOnDispose ?? false
			const table = factory(tableName)

			if (getTableName(table) !== tableName) {
				throw new Error(
					`[DrizzleOrm] invalid table factory: expected table name "${tableName}", got "${getTableName(table)}"`,
				)
			}

			if (!existing) {
				const rec: RegisteredTable = {
					scopeKey,
					scopePrefix: prefix,
					baseTableName,
					tableName,
					table,
					dropTableOnDispose,
				}
				const handle = new TableHandleImpl(() => this.releaseTable(rec.tableName, rec.scopeKey), rec, (err, name) => {
					this.ctx.logger.debug('dispose failed ({name})', { name, error: err })
				})
				rec.handle = handle

				shared.tables.set(tableName, rec)

				const scope = this.ctx.caller?.scope ?? this.ctx.scope
				scope.collectEffect(() => handle.disposeSafe())

				if (ensureSchema) await this.ensureTable(table)
				return handle as unknown as DrizzleOrmTableHandle<TTable>
			}

			existing.scopePrefix = prefix
			existing.baseTableName = baseTableName
			existing.table = table
			existing.dropTableOnDispose = dropTableOnDispose

			if (ensureSchema) await this.ensureTable(table)
			return existing.handle! as unknown as DrizzleOrmTableHandle<TTable>
		})
	}

	private async releaseTable(tableName: string, scopeKey: DrizzleOrmScopeKey): Promise<void> {
		const shared = this.shared()
		await shared.opQueue.run(async () => {
			const rec = shared.tables.get(tableName)
			if (!rec) return
			if (rec.scopeKey !== scopeKey) return

			shared.tables.delete(tableName)

			if (rec.dropTableOnDispose) {
				await this.dropTableIfExists(tableName)
			}
		})
	}

	private async ensureReady(): Promise<void> {
		await this.init()
		if (!this.shared().client || !this.shared().db) throw new Error('[DrizzleOrm] not initialized')
	}

	protected async ensureTable(table: SQLiteTable): Promise<void> {
		const tableName = getTableName(table)
		const client = await this.client()

		const exists = await hasTable(client, tableName)
		if (!exists) {
			const ddl = buildCreateTableSql(table)
			await client.execute(ddl)
		} else {
			await ensureMissingColumns(client, table)
		}

		// Indexes / uniques: best-effort idempotent creation.
		const { indexes, uniqueConstraints } = getTableConfig(table)
		for (const idx of indexes) {
			const sql = buildCreateIndexSql(idx)
			if (sql) await client.execute(sql)
		}
		for (const uc of uniqueConstraints) {
			const sql = buildCreateUniqueIndexSql(tableName, uc)
			if (sql) await client.execute(sql)
		}
	}

	override async ensureSchema(): Promise<void> {
		await this.exclusive(async () => {
			for (const rec of this.shared().tables.values()) {
				await this.ensureTable(rec.table)
			}
		})
	}

	protected override async migrateFor(
		scopeKey: DrizzleOrmScopeKey,
		options: DrizzleOrmMigrateOptions,
	): Promise<void> {
		await this.exclusive(async () => {
			const prefix = this.scopePrefixFor(scopeKey)
			const configMigrations = (this.shared().config as any)?.migrations as
				| DrizzleOrmMigrateOptions['migrations']
				| undefined
			const base = options?.migrations ?? configMigrations
			if (!base?.migrationsFolder) {
				throw new Error('[DrizzleOrm] migrate() requires migrations.migrationsFolder')
			}

			const next: MigrationConfig = { ...base }
			const baseTable = String(next.migrationsTable ?? 'drizzle_migrations')
			next.migrationsTable = `${prefix}_${stripPrefix(baseTable, prefix)}`

			const db = await this.db()
			await migrateLibsql(db, next)
		})
	}

	protected async dropTableIfExists(tableName: string): Promise<void> {
		const client = await this.client()
		await client.execute(`drop table if exists ${qIdent(tableName)}`)
	}
}

function scopePrefix(input: string): string {
	const raw = input.trim()
	const sanitized = raw.replace(/[^a-zA-Z0-9_]+/g, '_') || 'caller'
	if (sanitized === raw && /^[a-zA-Z0-9_]+$/.test(raw)) return raw
	const hash = createHash('sha1').update(raw).digest('hex').slice(0, 6)
	return `${sanitized}_${hash}`
}

function getScopePrefix(shared: SharedState<any>, scopeKey: DrizzleOrmScopeKey): string {
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

function qIdent(name: string): string {
	return `"${String(name).replaceAll('"', '""')}"`
}

async function hasTable(client: Client, tableName: string): Promise<boolean> {
	const rs = await client.execute("select name from sqlite_master where type='table' and name=?", [tableName])
	return Array.isArray(rs.rows) && rs.rows.length > 0
}

function buildCreateTableSql(table: SQLiteTable): string {
	const name = getTableName(table)
	const cfg = getTableConfig(table)

	const colDefs: string[] = []
	for (const col of cfg.columns) {
		colDefs.push(buildColumnDef(col as any))
	}

	// Composite PKs (table-level)
	for (const pk of cfg.primaryKeys) {
		const cols = pk.columns.map((c) => qIdent(c.name)).join(', ')
		colDefs.push(`primary key (${cols})`)
	}

	// Unique constraints: represented as unique indexes in ensureTable (safe).
	// Foreign keys/checks: skip to keep runtime ensure safe/minimal.

	return `create table if not exists ${qIdent(name)} (${colDefs.join(', ')})`
}

function buildColumnDef(col: any): string {
	const parts: string[] = [qIdent(col.name), String(col.getSQLType?.() ?? col.columnType ?? 'blob')]

	const isAutoincrement = !!col?.config?.isAutoincrement
	if (col.primary) {
		// For SQLite, PRIMARY KEY AUTOINCREMENT must be on an INTEGER column.
		parts.push('primary key')
		if (isAutoincrement) parts.push('autoincrement')
	}

	if (col.notNull) parts.push('not null')
	if (col.isUnique) parts.push('unique')

	// best-effort default for primitives only
	if (col.hasDefault && col.default !== undefined) {
		const d = col.default
		if (typeof d === 'number') parts.push(`default ${d}`)
		else if (typeof d === 'bigint') parts.push(`default ${d.toString(10)}`)
		else if (typeof d === 'boolean') parts.push(`default ${d ? 1 : 0}`)
		else if (typeof d === 'string') parts.push(`default '${d.replaceAll("'", "''")}'`)
	}

	return parts.join(' ')
}

async function ensureMissingColumns(client: Client, table: SQLiteTable): Promise<void> {
	const tableName = getTableName(table)
	const existing = await client.execute(`pragma table_info(${qIdent(tableName)})`)
	const existingNames = new Set(existing.rows.map((r: any) => String((r as any).name)))

	const cfg = getTableConfig(table)
	for (const col of cfg.columns as any[]) {
		if (existingNames.has(String(col.name))) continue

		// SQLite ALTER TABLE ADD COLUMN is limited; keep it minimal and safe.
		const type = String(col.getSQLType?.() ?? col.columnType ?? 'blob')
		let ddl = `alter table ${qIdent(tableName)} add column ${qIdent(col.name)} ${type}`
		if (col.hasDefault && col.default !== undefined) {
			const d = col.default
			if (typeof d === 'number') ddl += ` default ${d}`
			else if (typeof d === 'bigint') ddl += ` default ${d.toString(10)}`
			else if (typeof d === 'boolean') ddl += ` default ${d ? 1 : 0}`
			else if (typeof d === 'string') ddl += ` default '${d.replaceAll("'", "''")}'`
		}
		// Only add NOT NULL when default exists (otherwise SQLite will reject for existing rows).
		if (col.notNull && col.hasDefault) ddl += ' not null'

		await client.execute(ddl)
	}
}

function buildCreateIndexSql(index: any): string | null {
	const cfg = index?.config
	if (!cfg) return null
	if (cfg.where) return null
	if (!Array.isArray(cfg.columns) || cfg.columns.some((c: any) => typeof c?.name !== 'string')) return null

	const tableName = getTableName(cfg.table)
	const cols = cfg.columns.map((c: any) => qIdent(c.name)).join(', ')
	const unique = cfg.unique ? 'unique ' : ''
	return `create ${unique}index if not exists ${qIdent(cfg.name)} on ${qIdent(tableName)} (${cols})`
}

function buildCreateUniqueIndexSql(tableName: string, uc: any): string | null {
	const cols = Array.isArray(uc?.columns) ? uc.columns : null
	if (!cols || cols.some((c: any) => typeof c?.name !== 'string')) return null
	const name = typeof uc?.getName === 'function' ? uc.getName() : uc?.name
	const effective = name ? String(name) : `ux_${tableName}_${cols.map((c: any) => c.name).join('_')}`
	const colsSql = cols.map((c: any) => qIdent(c.name)).join(', ')
	return `create unique index if not exists ${qIdent(effective)} on ${qIdent(tableName)} (${colsSql})`
}

class TableHandleImpl implements DrizzleOrmTableHandle {
	private static readonly ASYNC_DISPOSE: unique symbol =
		(Symbol as any).asyncDispose ?? Symbol.for('Symbol.asyncDispose')
	private static readonly DISPOSE: unique symbol = (Symbol as any).dispose ?? Symbol.for('Symbol.dispose')

	private disposed = false

	constructor(
		private readonly disposeFn: () => Promise<void>,
		private readonly rec: RegisteredTable,
		private readonly onDisposeError: (err: unknown, tableName: string) => void,
	) {
		;(this as any)[TableHandleImpl.ASYNC_DISPOSE] = () => this.dispose()
		;(this as any)[TableHandleImpl.DISPOSE] = () => {
			void this.dispose()
		}
	}

	get scopeKey() {
		return this.rec.scopeKey
	}

	get scopePrefix() {
		return this.rec.scopePrefix
	}

	get baseTableName() {
		return this.rec.baseTableName
	}

	get tableName() {
		return this.rec.tableName
	}

	get table() {
		return this.rec.table
	}

	disposeSafe() {
		void this.dispose().catch((err) => {
			this.onDisposeError(err, this.tableName)
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
