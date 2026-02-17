# Data plugins

目标：提供“可复用的数据能力”，业务插件不要自己造轮子。

通常你会在 Host 里启用这些插件包，然后业务插件只依赖 token/服务 API。

包清单（按用途分组）：
- KV：`pluxel-plugin-kv`
- SQL / ORM：
  - Drizzle：`pluxel-plugin-drizzle-orm`
  - MikroORM：`pluxel-plugin-mikro-orm`
  - Ledger：`pluxel-plugin-ledger` / `pluxel-plugin-ledger-mikro-orm`
- 外部存储：
  - Redis：`pluxel-plugin-redis`
  - S3：`pluxel-plugin-s3mini`

常见误用：
- 把具体 ORM 实现类当成业务依赖类型（导致强耦合）：业务侧优先依赖稳定 token/API。

