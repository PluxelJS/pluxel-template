# pluxel-plugin-drizzle-orm

**固定组合：Drizzle ORM (sqlite) + libsql** 的 service 插件。

目标是减少抽象层，同时保留 MikroOrm 风格的「scope + 动态注册 + 运行时建表/补列」能力。

## 安装 / 注册

```ts
import DrizzleOrm, { plugins as drizzlePlugins } from 'pluxel-plugin-drizzle-orm'

export const plugins = [
	...drizzlePlugins,
	// ...your plugins
]
```

## 配置

```jsonc
{
	"plugins": {
		"DrizzleOrm": {
			"config": {
				"dbName": "./data/pluxel.sqlite",
				"authToken": "",
				"intMode": "number",
				"migrations": {
					"migrationsFolder": "./drizzle"
				},
				"migrateOnInit": false,
				"ensureSchemaOnInit": true
			}
		}
	}
}
```

`dbName` 支持：

- 本地文件路径（相对路径会被归一化为绝对路径）
- `:memory:`（会自动转换为 `file::memory:`）
- `file:` / `file://` / `libsql:` / `http(s):` / `ws(s):` URL

## 用法

### 1) 直接使用 Drizzle

```ts
import { Plugin } from '@pluxel/hmr'
import { DrizzleOrm } from 'pluxel-plugin-drizzle-orm'

@Plugin({ name: 'MyPlugin' })
export class MyPlugin {
	constructor(private readonly drizzle: DrizzleOrm) {}

	async ping() {
		const db = await this.drizzle.db()
		const rows = await db.select().execute()
		return rows.length
	}
}
```

### 2) 动态注册表（带 scope 前缀）

```ts
import { sqliteTable, integer, text } from 'pluxel-plugin-drizzle-orm/drizzle-orm/sqlite-core'
import { tableFactory } from 'pluxel-plugin-drizzle-orm'

const Users = tableFactory('users', (tableName) =>
	sqliteTable(tableName, {
		id: integer('id').primaryKey({ autoIncrement: true }),
		name: text('name').notNull(),
	}),
)

const handle = await drizzle.registerTable(Users)
// handle.tableName -> `${callerPluginId}_users`
```

脚本/测试场景可以显式 scope：

```ts
const handle = await drizzle.scope('Script').registerTable(Users)
```

> `registerTable()` 会在首次注册时自动建表，并对缺失列做安全补齐（`ALTER TABLE ADD COLUMN`）。

### 2.1) 获取强类型 db.query

```ts
const handle = await drizzle.registerTable(Users)
const db = await drizzle.dbWithSchema({ users: handle.table })
// db.query.users ... 完整类型提示
```

### 3) 运行时迁移（按 scope 隔离）

```ts
// 使用调用方 scope + 配置中的 migrations
await drizzle.migrate()

// 或显式指定（仍会按 scope 前缀隔离 migrationsTable）
await drizzle.migrate({ migrations: { migrationsFolder: './drizzle' } })
```
