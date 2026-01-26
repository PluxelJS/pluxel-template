# pluxel-plugin-ledger-mikro-orm

`pluxel-plugin-ledger` 的本地持久化 provider（MikroORM / libsql 等）。

前置条件：你需要同时注册一个 `MikroOrm` provider（例如 `pluxel-plugin-mikro-orm` 的默认 provider）。

```ts
import { plugins as mikroOrmPlugins } from 'pluxel-plugin-mikro-orm'
import { plugins as ledgerPlugins } from 'pluxel-plugin-ledger-mikro-orm'
```

设计文档：`packages/ledger-mikro-orm/ledger.md`
