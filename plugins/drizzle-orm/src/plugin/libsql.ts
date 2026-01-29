import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Client, Config as LibsqlConfig } from '@libsql/client'
import { createClient } from '@libsql/client'
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql'
import { __registerConfigSchema__ as registerConfigSchema, type Config, Plugin } from '@pluxel/hmr'
import { v } from '@pluxel/hmr/config'
import { DrizzleOrm, DrizzleOrmProvider } from './core.js'

export const DrizzleOrmConfigSchema = v.object({
	/** sqlite 文件路径；libsql 也支持 file/https/libsql:// 形式 */
	dbName: v.optional(v.string(), './data/pluxel.sqlite'),
	/** libsql token（可选） */
	authToken: v.optional(v.string()),
	/** 可选：intMode = number|string|bigint */
	intMode: v.optional(v.string()),
	/**
	 * 启动后自动 ensure（仅建表/补列）。
	 * 默认：若启用 migrateOnInit 则为 false，否则为 true。
	 */
	ensureSchemaOnInit: v.optional(v.boolean()),
	/** 启动后自动执行 migrations（需要配置 migrations）。默认 false。 */
	migrateOnInit: v.optional(v.boolean(), false),
	/** 迁移配置（可在 migrate() 中省略参数）。 */
	migrations: v.optional(
		v.object({
			migrationsFolder: v.string(),
			migrationsTable: v.optional(v.string()),
			migrationsSchema: v.optional(v.string()),
		}),
	),
	/** migrateOnInit 使用的 scope key（默认：当前插件 id）。 */
	migrationsScopeKey: v.optional(v.string()),
})

type DrizzleOrmLibsqlConfig = Config<typeof DrizzleOrmConfigSchema>

@Plugin(DrizzleOrm, { name: 'DrizzleOrm', type: 'service' })
export class DrizzleOrmLibsql extends DrizzleOrmProvider<DrizzleOrmLibsqlConfig> {
	private config: DrizzleOrmLibsqlConfig = this.configs.use(DrizzleOrmConfigSchema)

	protected override readConfig(): DrizzleOrmLibsqlConfig {
		return this.config
	}

	protected override async createClient(config: DrizzleOrmLibsqlConfig): Promise<Client> {
		const { url, filePath } = resolveLibsqlUrl(config.dbName)
		if (filePath) await mkdir(path.dirname(filePath), { recursive: true })

		const clientConfig: LibsqlConfig = {
			url,
			...(config.authToken ? { authToken: config.authToken } : {}),
			...(config.intMode ? { intMode: coerceIntMode(config.intMode) } : {}),
		}
		this.ctx.logger.info('init ({url})', { url })
		return createClient(clientConfig)
	}

	protected override async createDb(client: Client, _config: DrizzleOrmLibsqlConfig): Promise<LibSQLDatabase<any>> {
		return drizzle(client)
	}

	override async init(abort?: AbortSignal): Promise<void> {
		await super.init(abort)
		const cfg = this.config

		if (cfg.migrateOnInit && cfg.migrations) {
			const scopeKey = cfg.migrationsScopeKey ?? this.ctx.pluginInfo.id
			await this.migrateFor(scopeKey, { migrations: cfg.migrations })
		}

		const ensureOnInit = cfg.ensureSchemaOnInit ?? !cfg.migrateOnInit
		if (ensureOnInit) {
			await this.ensureSchema()
		}
	}
}

registerConfigSchema(DrizzleOrmLibsql, 'config', DrizzleOrmConfigSchema)

function coerceIntMode(raw: string): LibsqlConfig['intMode'] {
	if (raw === 'bigint' || raw === 'string' || raw === 'number') return raw
	return 'number'
}

function resolveLibsqlUrl(dbName: string): { url: string; filePath?: string } {
	const raw = String(dbName ?? '').trim()
	if (!raw) throw new Error('[DrizzleOrm] invalid config: dbName (empty)')
	if (raw === ':memory:') return { url: 'file::memory:' }

	if (
		raw.startsWith('libsql:') ||
		raw.startsWith('http://') ||
		raw.startsWith('https://') ||
		raw.startsWith('ws://') ||
		raw.startsWith('wss://')
	) {
		return { url: raw }
	}

	if (raw.startsWith('file://')) {
		const filePath = fileURLToPath(raw)
		return { url: `file:${filePath}`, filePath }
	}

	if (raw.startsWith('file:')) {
		const parsed = parseFileSqliteUri(raw)
		if (!parsed.filePath) return { url: raw }
		return { url: `file:${parsed.filePath}`, filePath: parsed.filePath }
	}

	const abs = path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw)
	return { url: `file:${abs}`, filePath: abs }
}

function parseFileSqliteUri(url: string): { filePath?: string } {
	if (!url.startsWith('file:')) return {}
	if (url === 'file::memory:') return {}

	if (url.startsWith('file:///')) {
		try {
			return { filePath: fileURLToPath(url) }
		} catch {
			return {}
		}
	}

	const rest = url.slice('file:'.length)
	const beforeQuery = rest.split('?')[0] ?? ''
	if (!beforeQuery) return {}
	if (beforeQuery === ':memory:' || beforeQuery === '::memory:') return {}
	if (beforeQuery.includes(':memory:')) return {}

	const filePath = beforeQuery.startsWith('/') ? beforeQuery : path.join(process.cwd(), beforeQuery)
	return { filePath }
}
