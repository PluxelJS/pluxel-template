# pluxel-plugin-ledger

TigerBeetle 兼容形态的“账本/复式记账”核心抽象（token + builders + 常用 TB 枚举/类型导出）。

目标：业务只依赖 `tigerbeetle-node` 同形态接口；后端实现（本地 DB / TigerBeetle）作为 provider 插件可随时切换。

## 安装 / 注册（选择一个 provider）

- 生产（TigerBeetle）：本包自带 `LedgerTigerBeetle` provider
- 本地持久化（MikroORM）：`pluxel-plugin-ledger-mikro-orm`

> `pluxel-plugin-ledger-mikro-orm` 需要同时注册一个 `MikroOrm` provider（例如 `pluxel-plugin-mikro-orm` 的默认 provider）。

## 作为服务使用（推荐）

在插件里注入 `Ledger`，直接调用 TigerBeetle 同形态方法：

```ts
import { BasePlugin, Plugin } from '@pluxel/hmr'
import { Ledger, newAccount, newTransferPosted } from 'pluxel-plugin-ledger'

@Plugin({ name: 'Billing', type: 'service' })
export class Billing extends BasePlugin {
  constructor(private readonly ledger: Ledger) {
    super()
  }

  async init() {
    const accounts = [
      newAccount({ id: 1n, ledger: 1, code: 1 }),
      newAccount({ id: 2n, ledger: 1, code: 1 }),
    ]
    await this.ledger.createAccounts(accounts)

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
    await this.ledger.createTransfers(transfers)
  }
}
```

## 直接复用 tigerbeetle-node 的类型/枚举

本包也会从 `tigerbeetle-node` 再导出常用 enum/类型，便于下游只依赖一处（例如 `AccountFlags` / `TransferFlags` / `CreateTransferError` 等）。
