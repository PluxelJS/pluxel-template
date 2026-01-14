# Ledger (MikroORM) — TigerBeetle-compatible 本地持久化设计

面向：后端内部服务调用（生产用 TigerBeetle；本地开发/CI 用 DB 模拟）。

目标：
- 业务侧只依赖 `tigerbeetle-node` 同形态的 `Ledger`（见 `pluxel-plugin-ledger`），无需感知底层是 TigerBeetle 还是本地 DB。
- 本地实现优先覆盖“常用路径”的一致性；遇到 TigerBeetle 特有但本地难以/不准备模拟的语义，允许 **throw**（让业务尽早发现不兼容点）。

## 1) 兼容性原则（以 TigerBeetle 为准）
- **同形态 API**：`createAccounts / lookupAccounts / createTransfers / lookupTransfers / getAccountTransfers / getAccountBalances / query*` 方法签名、返回结构与 `tigerbeetle-node` 保持一致。
- **返回约定**：创建类方法成功返回 `[]`，失败返回 `{ index, result }[]`（按 TigerBeetle 的 error enum）。
- **幂等键**：创建类事件以 `id` 为幂等键（重复创建返回 `exists` 类错误项）。
- **账户不可变**：账户创建后不可修改/不可删除（余额字段仅由 transfer 推进）。
- **lookup 不保证顺序**：对齐 TigerBeetle 行为，不假设与输入顺序一致。
- **linked 语义**：请求内支持 `linked` 链；链中任一失败会回滚链上后续并返回 `linked_event_failed`。

## 2) 本地实现覆盖的“常用子集”
必须覆盖（核心复式记账）：
- `createAccounts`, `lookupAccounts`
- `createTransfers`, `lookupTransfers`
- Transfer：`posted`、`pending`、`post_pending_transfer`、`void_pending_transfer`
- 账户 flags：`debits_must_not_exceed_credits`、`credits_must_not_exceed_debits`

可选择性覆盖 / 允许 throw：
- `imported`、balancing/closing 等扩展 flags
- 极端边界行为（例如跨请求/跨进程强一致时钟、超大批量吞吐等）

## 3) 数据库存储（概览）
本地实现使用 MikroORM 的 `SqlEntityManager.execute(...)` 直接执行 SQL，确保事务上下文一致（避免跨连接/跨事务问题）。

表（base name，实际会被 MikroORM scope 前缀化）：
- `accounts`：账户（u128 字段以 decimal string 存储）
- `transfers`：转账/事件（包括 posted 与 pending，以及 post/void 事件本身）
- `pending_resolution`：pending 的状态机补表（resolved/expired 等）
- `cluster_clock`：本地单调 timestamp 分配（批量预留以减少写放大）

## 4) 错误处理策略
- 能映射到 TigerBeetle `CreateAccountError` / `CreateTransferError` 的，尽量返回对应 `result`。
- 对于本地实现无法可靠模拟或当前未覆盖的特性，直接抛出 `Error`（避免静默产出“看似成功但语义不一致”的数据）。

## 参考
- TigerBeetle docs: https://docs.tigerbeetle.com/
- Node client: https://docs.tigerbeetle.com/coding/clients/node/
