# pluxel-plugin-mikro-orm

一个面向 Pluxel 插件系统的 MikroORM（libsql/sqlite）服务插件。

## 设计要点

- **强制 scope 隔离**：动态注册的表名恒为 `${scopePrefix}_${baseTableName}`（分隔符固定 `_`）。
- **不提供命名空间配置**：避免“可选项太多导致行为不确定”，跨插件冲突直接用 scope 前缀解决。
- **输入 schema 可复用**：`scope().registerEntity()` 内部会 clone schema；不同插件可以安全复用同一个 `EntitySchema` 常量。

## 基本用法

在你的插件里依赖 `MikroOrm`，并在生命周期里注册实体：

```ts
import { BasePlugin, Plugin } from '@pluxel/hmr'
import { EntitySchema } from '@mikro-orm/core'
import { MikroOrm } from 'pluxel-plugin-mikro-orm'

const UserSchema = new EntitySchema({
  name: 'User',
  tableName: 'users',
  properties: {
    id: { primary: true, type: 'number' },
    name: { type: 'string' },
  },
})

@Plugin({ name: 'MyPlugin', type: 'service' })
export class MyPlugin extends BasePlugin {
  constructor(private readonly mikro: MikroOrm) {
    super()
  }

  async init() {
    const h = await this.mikro.registerEntity(UserSchema)
    // 表名会是：MyPlugin_users
    const em = await this.mikro.em()
    await em.getConnection().execute(`insert into "${h.tableName}" (id, name) values (?, ?)`, [1, 'alice'])
  }
}
```

## 重要语义（层级/包装插件）

默认用法下你不需要手写 `scope()`：在插件里直接调用 `mikro.registerEntity()` 就会使用 caller-scope。

`scope()` 提供的是“显式 scopeKey”的高级能力：当你在宿主/脚本/测试里没有 caller，但又需要注册实体/跑 migrations 时使用。

如果你写了一个“Wrapper 插件”把 `MikroOrm` 转发给别的插件：

- 通过 Wrapper 调用 `scope().registerEntity()` 时，表会以 `Wrapper_` 为前缀
- 如果希望“谁用谁的表”，让目标插件 **直接依赖 MikroOrm**（不要二次封装转发）

## `scope().registerEntity()` 返回值

- `handle.tableName`：实际表名（恒带 scope 前缀）
- `handle.entityName`：实际注册到 MikroORM 的实体名（也会带 scope 前缀）
- `handle.schema`：实际注册进 MikroORM 的 schema（内部 clone）；建议后续查询优先用它
- `handle.scopeKey / handle.scopePrefix`：该实体所属 scope 以及其计算后的前缀
