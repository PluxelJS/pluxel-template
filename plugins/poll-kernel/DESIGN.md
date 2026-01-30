# Poll Kernel V1 — Implementation Design (Normalized SQL + Transactional Replay)

> 说明：本文档描述**当前代码实现**的真实架构与优化取舍，非“理想化草案”。

---

## 1. 目标与边界

- 内核只识别 `principalId`，不处理权限/风控/资格。
- 写语义固定为 Replace：`castVote` 永远“替换当前投票”。
- 计分采用整数 `bigint`（聚合为字符串持久化）。
- 幂等由 `requestId + payload_hash` 保证，可回放结果。
- 同一 poll 的写请求在单事务内线性化。

---

## 2. API 与结果结构（实现一致）

### 2.1 Code

- `OK`
- `IDEMPOTENT_MISMATCH`：同 requestId 不同 payload，拒绝
- `INVALID` / `NOT_OPEN` / `CLOSED`
- `UPDATE_FORBIDDEN` / `RETRACT_FORBIDDEN` / `NO_VOTE`
- `WEIGHT_INVALID`

> 注意：实现中**回放返回的是历史 Decision 本体**（code 与首次一致），而不是显式返回 `IDEMPOTENT`。

### 2.2 ResultsSnapshot

- `counts[i]`：选项 i 的人数（±1）
- `totals[i]`：选项 i 的加权得分（±w）

---

## 3. 规范化存储（SQL / MikroORM）

> 目标：避免“整坨 JSON 状态”写放大，以行级更新实现最小写入。

### 3.1 表结构

#### poll_meta
- `poll_id` (PK)
- `spec_json` (TEXT, schemaVersion=1，BigInt 用 string)
- `closed` (BOOL)
- `open_at_ms` / `close_at_ms` (BIGINT nullable)
- `participants` (INT)
- `version` (INT)
- `created_at_ms` / `updated_at_ms` (BIGINT)

#### poll_choice_agg
- `poll_id`
- `choice_idx`
- `count_text` (TEXT, bigint)
- `total_text` (TEXT, bigint)
- PK `(poll_id, choice_idx)`

#### poll_vote
- `poll_id`
- `principal_id`
- `sel_kind` (BITSET64 | U16)
- `sel_data` (TEXT)
- `weight_text` (TEXT, bigint)
- `updated_at_ms`
- PK `(poll_id, principal_id)`

#### poll_request
- `poll_id`
- `request_id`
- `payload_hash` (sha256 hex)
- `result_json` (Decision JSON)
- `version`
- `created_at_ms`
- PK `(poll_id, request_id)`

---

## 4. Selection 编码

- `choices <= 64`：bitset64（BigInt）
- `choices > 64`：sorted Uint16

持久化编码：
- BITSET64：`0x...` 十六进制字符串
- U16：`[1,5,9]` JSON 数组

解析时校验：
- choiceId 合法、无重复
- single：必须 1 项
- multi：`1..maxSelections`

---

## 5. 权重处理（bigint）

- `none` ⇒ `1n`
- `external` ⇒ 必填 `ctx.weight`
- 校验：`min <= w <= max` 且 `w > 0`

---

## 6. 幂等与回放（payload_hash）

### payload_hash
- sha256(JSON canon)：
  - op type
  - principalId（cast/retract）
  - selection（按 index 升序）
  - weight（已 resolve）

### 语义
- requestId 首次出现：执行并写入 result_json
- requestId 重放：回放 result_json
- requestId payload 不同：`IDEMPOTENT_MISMATCH`

---

## 7. 写路径（单事务线性化）

`mutateBatch(pollId, reqs)` 在**单事务**完成：

1. 读取并锁定 poll_meta（确保线性化）
2. 批量预取 poll_request（检测回放/冲突）
3. 对需执行的请求：
   - 解析 selection / 权重
   - 读取投票记录（批量预取）
   - diff 更新 counts/totals
   - 更新 poll_vote
4. 批量更新 touched choice 行
5. 若有变更：`version + 1`，更新 poll_meta
6. 写入 poll_request 结果

**重要优化**：
- 批量预取 request/vote，避免 N+1 查询
- agg/投票仅在需要写入时才加载（close-only 批次不触发）
- 仅更新 touched choice 行
- 版本仅在“本批有变更”时 +1

---

## 8. Diff 与 totals 正确性

- diff = removed / added
- removed：`count -= 1`，`total -= oldW`
- added：`count += 1`，`total += newW`
- 若权重变化且存在交集：交集项 `total += (newW - oldW)`

此处是实现中的关键修复点，保证 totals 不被低估/高估。

---

## 9. 读路径与缓存

`getResults`：
1. 读 poll_meta
2. 若快照缓存版本一致 ⇒ 直接返回
3. 否则读 poll_choice_agg，生成 snapshot

缓存策略：
- 结果快照缓存：SieveCache（按 pollId）
- 每 poll 写队列：降低同 poll 并发冲突
- spec 规范化缓存：repo 内部 SieveCache

---

## 10. 设计取舍总结（当前实现）

- **规范化存储**优先：避免 JSON 状态写放大
- **单事务线性化**：无需 CAS/重试
- **回放即原结果**：稳定性强，不额外编码 IDEMPOTENT
- **counts + totals 双轨**：读路径更直接
- **批量预取 + touched update**：降低 IO 与写放大

