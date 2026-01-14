````md
# TigerBeetle 兼容的本地数据库“模拟账本”设计文档（MikroORM 版）
面向：后端内部服务调用（生产用 TigerBeetle；本地开发/CI 用 DB 模拟），目标是未来**无痛切换/迁移到 TigerBeetle**。  
核心原则：**复用 tigerbeetle-node 的类型与请求/返回形态**，本地实现只替换“存储与执行引擎”，不复用 TigerBeetle 内部逻辑代码。

---

## 0. 约束与迁移目标（必须满足）
### 0.1 以 TigerBeetle 行为为准
- **请求模型**：一次请求只包含同一种 event（例如 `create_transfers` 不能混入 `create_accounts`）。请求整体提交；事件按顺序执行，后续事件能观察到前面事件的效果；不同请求之间不会交错；**事件默认可独立成功/失败，除非显式 linked**。:contentReference[oaicite:0]{index=0}
- **幂等**：创建类事件以 `id` 为幂等键；第一次创建为 ok，后续同 id 创建返回 exists（对 Node client 来说会以“错误项”体现）。:contentReference[oaicite:1]{index=1}
- **账户不可变/不可删除**（除余额字段由 transfer 推进）：账户创建后用户不能修改字段，也不能删除。:contentReference[oaicite:2]{index=2}
- **Node client 形态必须一致**：
  - `createAccounts` / `createTransfers`：成功返回空数组；失败返回“错误数组”，每项包含 `index` 与 `result`。:contentReference[oaicite:3]{index=3}
  - `lookupAccounts`：不存在就不返回该对象；返回顺序不保证与输入一致。:contentReference[oaicite:4]{index=4}

> 迁移含义：只要你的业务仅依赖这些行为与数据结构，本地 DB 实现可随时替换为 TigerBeetle adapter，而无需改业务调用代码。

### 0.2 本地 DB 模拟的“精简子集”范围（建议）
必须实现（核心复式记账）：
- `createAccounts`, `lookupAccounts`
- `createTransfers`, `lookupTransfers`（可选，但强烈建议）
- Transfer 的：posted、pending、post_pending_transfer、void_pending_transfer（两阶段转账）
- `linked` 链语义（最关键，决定请求内原子链）
- 账户约束（flags）：`debits_must_not_exceed_credits` 与 `credits_must_not_exceed_debits`

可以延后（不影响大多数内部服务本地开发）：
- `imported` 相关（导入历史 timestamp、混批约束）
- 高级 query（get_account_transfers / balances / query_*）
- balancing_*、closing_* 等扩展 flags

---

## 1. 类型复用策略（强制）
### 1.1 直接复用 tigerbeetle-node 类型
你的本地 adapter 对外暴露的类型必须来自 `tigerbeetle-node`，保证与生产一致。

**CommonJS 示例（与官方文档一致）**：:contentReference[oaicite:5]{index=5}
```js
const { createClient, id } = require("tigerbeetle-node");
````

**TypeScript 推荐（仅示意，具体以你项目 ESM/CJS 形态调整）**：

```ts
import type {
  Account,
  Transfer,
  CreateAccountError,
  CreateTransferError,
  AccountFlags,
  TransferFlags,
} from "tigerbeetle-node";
```

> 注意：TigerBeetle 的 `Account`/`Transfer` 在 TS 绑定里字段通常“全部必填”（很多要填 0），本地实现应提供 builder/helper，避免业务层散落大量 `0n/0`。

### 1.2 统一抽象接口（业务只认这一层）

定义一个与 TigerBeetle Node client **同形态**的接口（名称随意）：

```ts
export interface LedgerClient {
  createAccounts(accounts: Account[]): Promise<Array<{ index: number; result: number }>>;
  lookupAccounts(ids: bigint[]): Promise<Account[]>;

  createTransfers(transfers: Transfer[]): Promise<Array<{ index: number; result: number }>>;
  lookupTransfers(ids: bigint[]): Promise<Transfer[]>;
}
```

* TigerBeetle adapter：薄封装 `tigerbeetle-node` client。
* MikroORM adapter：本地 DB 事务执行 + 同样的返回形态（空数组=全成功，否则错误项）。

---

## 2. 数据库存储模型（MikroORM Entity 设计要点）

### 2.1 u128 / BigInt 的落库策略（关键）

TigerBeetle 的 `id/amount/...` 是 128-bit unsigned。很多数据库没有原生 u128。

推荐做法（通用、稳）：

* 所有 u128 字段：**以十进制字符串**存储（`text`/`varchar`），并加索引。
* 读写时统一：

  * `string -> BigInt`：`BigInt(str)`
  * `BigInt -> string`：`x.toString(10)`
* `timestamp`：TigerBeetle 用 u64 ns（且 < 2^63）。本地可用 signed `bigint` 存 ns；为简化也可存 string，但会麻烦排序。

### 2.2 核心表

#### accounts

字段建议（与 TB Account 结构保持同名/同语义）：

* `id` (string, unique)  —— u128
* `ledger` (int, not null, != 0)
* `code` (int/smallint, not null, != 0)
* `flags` (int, not null) —— bitfield
* `timestamp` (bigint, not null) —— 本地分配的“cluster time”，递增
* balances（string u128）：

  * `debits_pending`, `debits_posted`, `credits_pending`, `credits_posted`
* user_data：

  * `user_data_128` (string), `user_data_64` (string), `user_data_32` (int)
* `reserved` (int) —— 必须为 0（至少在精简子集里严控）

> 账户字段不可由用户更新（除 balances），且不可删除。([TigerBeetle][1])

#### transfers

字段建议：

* `id` (string, unique) —— u128
* `debit_account_id`, `credit_account_id` (string)
* `amount` (string u128)
* `pending_id` (string u128, default "0")
* `user_data_128/64/32`
* `timeout` (int seconds)
* `ledger` (int)
* `code` (int/smallint)
* `flags` (int)
* `timestamp` (bigint) —— 本地分配递增

#### pending_resolution（推荐单独表，保证“只能 resolve 一次”）

* `pending_id` (string, unique)
* `resolution_transfer_id` (string)
* `resolution` ("posted" | "voided" | "expired")
* `resolved_timestamp` (bigint)
* `posted_amount` (string u128) —— 对 post_pending_transfer 记录实际 posted
* `expires_at` (bigint, nullable) —— pending transfer 的过期时间（created_ts + timeout）

> TigerBeetle 强调 transfer 不可变；post/void 是创建一个新 transfer 来完成两阶段，不是修改 pending transfer。([TigerBeetle][2])

#### cluster_clock（单行表）

* `key` = "clock"
* `last_timestamp` (bigint)

用途：保证 accounts 与 transfers 的 timestamp 全局唯一、严格递增（模拟 TB 的 cluster timestamp 单调性）。([TigerBeetle][3])

---

## 3. 执行引擎语义（MikroORM adapter 的核心算法）

### 3.1 请求级事务骨架（必须）

* 每次 `createAccounts` / `createTransfers` 使用**单个 DB transaction**。
* 在同一请求内，**事件按数组顺序逐个执行**（不能先全量 validate 再执行），因为后续事件应能观察前面事件对余额/状态的影响。([TigerBeetle][3])
* 对于“独立事件失败不影响其他事件”，可用 **SAVEPOINT** 实现：

  * 每个事件（或每个 linked chain）一个 savepoint
  * 失败则 rollback 到 savepoint，记录错误；继续处理后续事件
* 对 linked chain：用 chain 级 savepoint（见 3.2）。

### 3.2 linked chain 处理（迁移兼容的关键点）

TigerBeetle 的 `flags.linked`：把当前事件与下一个事件绑定为“同成同败链”。Transfer 也同理。([TigerBeetle][4])

实现步骤：

1. 扫描 batch，按 `flags.linked` 切分成多个 segment（链）。

   * 若最后一个事件仍设置 `linked`：该事件应返回 `linked_event_chain_open`，且该链内其他事件返回 `linked_event_failed`（见 3.2.3）。([TigerBeetle][5])
2. 对每个 segment：

   * 建立 savepoint：`SAVEPOINT chain_X`
   * 逐个事件执行（会更新余额/插入 rows）
   * 若某个事件失败：

     * rollback 到 `chain_X`
     * 错误返回策略：

       * **失败事件**：返回其“首要错误码”（见 3.5 的 error precedence 思路）
       * **链内其他事件**：返回 `linked_event_failed`（表示“链内其他事件无效导致我失败”）。([TigerBeetle][5])
     * 链结束（不再继续执行链内后续事件的实际效果；但仍需要为它们生成 `linked_event_failed` 错误项）

> 这点如果做错，未来切 TigerBeetle 会出现“本地能过，线上链回滚”的典型坑。

### 3.3 createAccounts 语义（精简子集）

对每个 Account event：

* 必须字段与常见约束（至少做到）：

  * `id != 0`（以及非 max）
  * `ledger != 0`、`code != 0`（Account reference）([TigerBeetle][1])
  * balances 必须为 0（`debits_*`, `credits_*`）([TigerBeetle][1])
  * `reserved == 0`
  * `timestamp == 0`（当未使用 imported）([TigerBeetle][1])
* 幂等：

  * 若 accounts 表已存在该 id：返回 `exists`
  * 否则插入账户，分配 `timestamp`（用 2.2 的 cluster_clock）
* 返回：

  * 全成功：`[]`
  * 否则返回错误项数组：`[{ index, result }, ...]`（仅失败项）([TigerBeetle][6])

### 3.4 createTransfers 语义（精简子集 + 两阶段）

#### 3.4.1 基本 posted transfer（flags 不含 pending/post/void）

对每个 Transfer event：

* 基本合法性（至少）：

  * `id != 0`
  * `debit_account_id != credit_account_id`
  * 两账户必须存在，且 ledger 匹配：

    * 当不是 post/void：`ledger != 0` 且必须等于两账户 ledger。([TigerBeetle][4])
  * `code != 0`（当不是 post/void）([TigerBeetle][4])
  * `pending_id == 0`（当不是 post/void）([TigerBeetle][4])
  * `timestamp == 0`（未使用 imported；否则需走 imported 规则；精简子集可先拒绝 imported）([TigerBeetle][5])
* 账户约束 flags（必须实现两条）：

  * `debits_must_not_exceed_credits`：
    `debits_pending + debits_posted + transfer.amount <= credits_posted` 否则拒绝。([TigerBeetle][1])
  * `credits_must_not_exceed_debits`：
    `credits_pending + credits_posted + transfer.amount <= debits_posted` 否则拒绝。([TigerBeetle][1])
* 成功效果：

  * debit：`debits_posted += amount`
  * credit：`credits_posted += amount`
  * 插入 transfers 行，分配递增 timestamp

#### 3.4.2 pending transfer（flags.pending）

* 成功效果：

  * debit：`debits_pending += amount`
  * credit：`credits_pending += amount`
  * 插入 transfers 行（flags.pending）
  * 若 `timeout > 0`：写入 pending_resolution.expires_at = pending_ts + timeout_seconds（TigerBeetle timeout 是“区间秒数”，不是绝对时间）([TigerBeetle][2])

> TigerBeetle 会在 pending 阶段就保证不会破坏账户约束（悲观校验），因此 pending 创建也必须走 3.4.1 的约束检查。([TigerBeetle][2])

#### 3.4.3 post_pending_transfer（flags.post_pending_transfer）

规则要点：([TigerBeetle][2])

* `pending_id` 必须引用一个 pending transfer，且该 pending 尚未被 resolve（posted/void/expired）。
* `flags.void_pending_transfer` 不能同时 set。([TigerBeetle][2])
* 字段继承/一致性：

  * `debit_account_id/credit_account_id/ledger/code`：可以为 0 表示“继承 pending 的值”，否则必须匹配 pending 的对应值。([TigerBeetle][2])
* amount 规则：

  * 若 amount == `AMOUNT_MAX (2^128-1)`：表示“post 全额”（实际 posted_amount = pending.amount）。([TigerBeetle][2])
  * 否则必须 `amount <= pending.amount`；若大于则报 `exceeds_pending_transfer_amount`。([TigerBeetle][2])
  * 部分 post：posted_amount = amount；remaining = pending.amount - posted_amount；remaining 退回原账户（体现在 pending balances 释放后只把 posted_amount 计入 posted）。([TigerBeetle][2])
* 成功效果（最容易写错的地方）：

  1. 释放 pending 的保留额（全额释放）

     * debit：`debits_pending -= pending.amount`
     * credit：`credits_pending -= pending.amount`
  2. 增加 posted（按 posted_amount）

     * debit：`debits_posted += posted_amount`
     * credit：`credits_posted += posted_amount`
  3. 插入“posting transfer”行（该行是新的 transfer，不修改 pending transfer）([TigerBeetle][2])
  4. 写入 pending_resolution（确保只能 resolve 一次）

#### 3.4.4 void_pending_transfer（flags.void_pending_transfer）

规则要点：([TigerBeetle][2])

* `pending_id` 必须引用 pending transfer，且未 resolve。
* `flags.post_pending_transfer` 不能同时 set。([TigerBeetle][2])
* 字段继承同 3.4.3（debit/credit/ledger/code 可 0 继承，否则必须匹配）。
* amount 规则：

  * 若 amount == 0：自动视为 pending.amount。([TigerBeetle][4])
  * 若 amount != 0：必须等于 pending.amount。
* 成功效果：

  * debit：`debits_pending -= pending.amount`
  * credit：`credits_pending -= pending.amount`
  * 不增加 posted
  * 插入“void transfer”行
  * 写入 pending_resolution

#### 3.4.5 pending timeout（expire）

TigerBeetle：timeout 是秒间隔；过期后 pending 视为被 void（退回）。([TigerBeetle][2])

本地实现建议“按需清理”：

* 在以下路径前检查并处理过期：

  * `createTransfers`（任何 event 执行前）
  * `lookupAccounts` / `lookupTransfers`（可选）
* 处理逻辑：

  * 找到 `expires_at <= now_ts` 且未 resolve 的 pending_id
  * 执行与 void 相同的余额释放（debits_pending/credits_pending 全额减回）
  * 写入 pending_resolution（resolution="expired"），并插入一条“系统生成 transfer”可选（若你要对齐 TB 的可审计性，建议插入一条 void_pending_transfer 语义的 transfer；否则至少记录 resolution）

---

## 4. 并发与锁（本地实现也要防止语义漂移）

### 4.1 同一请求内的锁顺序（避免死锁）

* 对每个 transfer event，会涉及两个 account 行更新。
* 强制按 account_id 排序后 `SELECT ... FOR UPDATE` 锁定两行，再做余额计算与写回。
* pending resolution 时也要锁 pending transfer 与 resolution 行（或用唯一约束冲突实现）。

### 4.2 “只能 resolve 一次”的实现

* `pending_resolution.pending_id` 做 UNIQUE
* 在 post/void/expire 时尝试插入：

  * 插入成功：继续执行余额迁移
  * 插入失败（唯一冲突）：返回 `pending_transfer_already_posted/voided/expired` 对应错误（或在精简子集里统一映射为一个错误码，但不推荐；未来迁移会踩坑）。([TigerBeetle][2])

---

## 5. 错误码映射策略（落地可操作）

### 5.1 必须遵守的“错误优先级”原则

TigerBeetle 的 create_transfers 文档说明：若多个错误同时适用，只返回优先级最高的那个。([TigerBeetle][5])

本地精简实现可采用“先做结构性/一致性错误，再做状态性错误，再做余额约束”的固定顺序，例如：

1. batch 结构错误：linked 链 open、flags 互斥、reserved flag 非 0
2. id 相关：id==0、重复等
3. 引用存在性：账户不存在、pending_id 不存在
4. pending 状态：pending_transfer_not_pending / already_* / expired
5. 字段一致性：post/void 时 debit/credit/ledger/code 不匹配
6. amount 规则：exceeds_pending_transfer_amount、void amount 不匹配
7. 余额约束：debits_must_not_exceed_credits / credits_must_not_exceed_debits

### 5.2 createTransfers 的 linked_event_failed / chain_open

* `linked_event_chain_open`：当最后一个事件仍设置 `flags.linked`，该事件返回 chain_open；同链其他事件返回 linked_event_failed。([TigerBeetle][5])
* `linked_event_failed`：链内因“别的事件”失败导致本事件失败。([TigerBeetle][5])

### 5.3 返回形态（务必与 Node client 一致）

* `createAccounts` / `createTransfers`：返回 `[]` 表示全成功；否则返回失败项（index + result）。([TigerBeetle][6])

---

## 6. Builder/Helper（强烈建议，降低业务层出错率）

给业务层一个“填零”的最小封装，避免散落 magic 0：

* `newAccount({ id, ledger, code, flags?, user_data? }) => Account`
* `newTransferPosted({ id, debit, credit, amount, ledger, code, flags?, user_data? }) => Transfer`
* `newTransferPending(...)`
* `newTransferPostPending({ id, pending_id, amount, ...inheritables })`
* `newTransferVoidPending({ id, pending_id, amount?, ...inheritables })`

理由：官方示例中 account/transfer 创建需要大量字段置 0。([TigerBeetle][6])

---

## 7. 适配器结构（生产/本地双实现）

### 7.1 TigerBeetleAdapter（生产）

* 直接包装 `createClient(...)` 得到的 client
* 方法名/签名对齐 LedgerClient
* 不做语义改写，只做参数透传与必要的类型转换（若你的业务有自定义 DTO）

### 7.2 MikroOrmAdapter（本地）

* 依上述规则实现事务语义、linked/savepoint、pending 两阶段
* 与 TigerBeetleAdapter 共享同一套 conformance tests（见 8）

---

## 8. Conformance Tests（确保“无痛迁移”的保险丝）

建议用同一套测试，分别跑：

* MikroOrmAdapter（SQLite/Postgres）
* TigerBeetleAdapter（启动本地 TB 集群）

最小测试集合：

1. createAccounts 幂等：同 id 二次创建 -> exists（错误项），第一次成功返回空数组 ([TigerBeetle][3])
2. posted transfer：两账户余额变化正确（debits_posted/credits_posted）
3. pending + post_full：pending balances 迁移到 posted（全额）([TigerBeetle][2])
4. pending + post_partial：pending 全额释放；posted 增加部分；剩余退回（体现为只增加 posted_amount）([TigerBeetle][2])
5. pending + void：pending 全额释放；posted 不变 ([TigerBeetle][2])
6. linked chain：链内任一事件失败 -> 链内其余事件返回 linked_event_failed，且链整体无副作用 ([TigerBeetle][5])
7. 账户约束 flags：触发 must_not_exceed_* 时拒绝（包括 pending 创建阶段）([TigerBeetle][1])

---

## 9. 实施检查清单（Codex 直接按此落地）

* [ ] LedgerClient 接口：方法签名与 Node client 返回形态一致（空数组=成功；错误项含 index/result）([TigerBeetle][6])
* [ ] MikroORM entities：accounts/transfers/pending_resolution/cluster_clock
* [ ] u128 字段落库用 string；读写统一 BigInt <-> string
* [ ] cluster_clock 分配 timestamp：全局唯一、严格递增（accounts 与 transfers 共用）
* [ ] createAccounts：零值校验、ledger/code 非 0、reserved=0、timestamp=0（非 imported）、幂等 exists ([TigerBeetle][1])
* [ ] createTransfers：按顺序执行；每事件或每链 savepoint；账户行按 id 排序 FOR UPDATE
* [ ] linked chain：segment 执行；失败 rollback；错误码填充 linked_event_failed / chain_open ([TigerBeetle][5])
* [ ] pending/post/void：完全按 3.4 规则更新 balances；pending_resolution 唯一保证只 resolve 一次 ([TigerBeetle][2])
* [ ] 账户约束 flags：两条公式（posted 与 pending 阶段都要校验）([TigerBeetle][1])
* [ ] conformance tests：同一套测试同时验证两种 adapter

---

## 10. 你需要明确的“业务侧纪律”（否则迁移会疼）

* 业务侧永远只依赖 LedgerClient（不要直接触碰 MikroORM 表结构）
* 业务侧不要假设 lookup 返回顺序与输入一致（TigerBeetle 明确不保证）([TigerBeetle][6])
* 业务侧不要写“更新 account 字段/删除 account”这种语义（TB 不允许）([TigerBeetle][1])
* 业务侧对两阶段转账必须使用 post/void 的新 transfer，而不是改 pending（TB 不改 pending）([TigerBeetle][2])

```

如果你希望我进一步把“错误码枚举映射表（本地实现至少要覆盖哪些 CreateTransferError/CreateAccountError 值）”也写成可复制的清单，我可以按 TigerBeetle 文档中最常见且与你的精简子集直接相关的错误项再补一节，便于 Codex 逐条实现与单测覆盖。
::contentReference[oaicite:56]{index=56}
```

[1]: https://docs.tigerbeetle.com/reference/account/ "Account"
[2]: https://docs.tigerbeetle.com/coding/two-phase-transfers/ "Two-Phase Transfers"
[3]: https://docs.tigerbeetle.com/coding/requests/ "Requests"
[4]: https://docs.tigerbeetle.com/reference/transfer/ "Transfer"
[5]: https://docs.tigerbeetle.com/reference/requests/create_transfers/ "create_transfers"
[6]: https://docs.tigerbeetle.com/coding/clients/node/ "tigerbeetle-node"
