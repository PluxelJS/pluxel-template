# pluxel-plugin-debit

TigerBeetle 兼容形态的“账本/复式记账”服务插件（token + 可替换 backend）。

目标：业务只依赖一层 `LedgerClient` 形态的接口，本地（内存/DB 模拟）与生产（TigerBeetle）可随时切换。

## 安装 / 注册

- 默认（MikroORM 持久化实现）：
  - `import { plugins as debitPlugins } from 'pluxel-plugin-debit'`

前置条件：你需要同时注册一个 `MikroOrm` provider（例如 `pluxel-plugin-mikro-orm` 的默认 provider），否则 `DebitMikroOrm` 无法注入数据库连接。

## 作为服务使用（推荐）

在插件里注入 `Debit`，直接调用 TigerBeetle 同形态方法：

```ts
import { BasePlugin, Plugin } from '@pluxel/hmr'
import { Debit, newAccount, newTransferPosted } from 'pluxel-plugin-debit'

@Plugin({ name: 'Billing', type: 'service' })
export class Billing extends BasePlugin {
  constructor(private readonly debit: Debit) {
    super()
  }

  async init() {
    const accounts = [
      newAccount({ id: 1n, ledger: 1, code: 1 }),
      newAccount({ id: 2n, ledger: 1, code: 1 }),
    ]
    await this.debit.createAccounts(accounts)

    const transfers = [
      newTransferPosted({
        id: 100n,
        debit_account_id: 1n,
        credit_account_id: 2n,
        amount: 50n,
        ledger: 1,
        code: 1,
      }),
    ]
    await this.debit.createTransfers(transfers)
  }
}
```

## TigerBeetle 后端（生产）

使用 `DebitTigerBeetle` 作为 `Debit` 的 provider（不要同时注册本地持久化 provider）。

> 具体如何在 Pluxel 中配置 `clusterId/replicaAddresses` 取决于你的应用装配方式；类上配置 schema 见 `DebitTigerBeetleConfigSchema`。

```ts
import { DebitTigerBeetle } from 'pluxel-plugin-debit'
```

## 参考设计文档

- `packages/debit/debit.md`
