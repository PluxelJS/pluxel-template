## Univer MVP 设计文档（Cap’n Web 控制面 + HTTP 数据面）

### 0) 目标与范围

* **MVP**：小表（全量一次性加载）、单用户或弱并发、无 OT。
* **核心功能**：打开/编辑/保存（手动+自动保存）、版本冲突提示。
* **硬约束**：运行时修改必须走 Univer command/Facade；不直接改 snapshot（保证 UI/插件/未来协作语义不被破坏）。([docs.univer.ai](https://docs.univer.ai/guides/sheets/getting-started/quickstart))
* **未来兼容**：后续可平滑加入 OT、增量日志、分块/tile、推送。

---

### 1) 数据模型与“同一份数据”的定义

* **唯一持久化格式**：`IWorkbookData`（Univer Sheets snapshot）。([docs.univer.ai](https://docs.univer.ai/guides/sheets/model/workbook-data))
* **保存来源**：前端从 `FWorkbook.save()` 获取最新 snapshot（不要依赖旧 snapshot 或手拼）。([docs.univer.ai](https://docs.univer.ai/guides/sheets/features/core/sheets-api))
* **插件数据**：写入 `snapshot.resources`（未来插件扩展不会丢）。需要自定义序列化/压缩时，按 Custom Model 的 `toJson/parseJson` 机制实现。([docs.univer.ai](https://docs.univer.ai/guides/recipes/tutorials/custom-model))

> 结论：后端第一期把 snapshot 当 **不透明 blob** 存取即可；不需要理解单元格。

---

### 2) 架构分层：Control Plane vs Data Plane（关键决策）

**原因**：Cap’n Web 擅长“会话/能力对象/多步行为编排/双向推送”，但底层是 JSON；纯读大对象更适合 HTTP（压缩、ETag、CDN 缓存、Range）。Cap’n Web 具备 HTTP batch mode、promise pipelining、WebSocket/HTTP/postMessage 等通道。([blog.cloudflare.com](https://blog.cloudflare.com/capnweb-javascript-rpc-library/))

#### 2.1 Control Plane（Cap’n Web）

* 鉴权与权限裁决（capability 对象）
* 多步保存工作流编排（begin → upload → commit）
* 订阅通知（未来：presence、变更推送、OT）

#### 2.2 Data Plane（HTTP）

* 快照（snapshot）与未来的大对象（tiles、附件等）
* 利用：`Content-Encoding`、`ETag`、`Cache-Control`、（未来）`Range`

---

### 3) HTTP 资源设计（快照强缓存、按 rev 不可变）

**核心原则**：`snapshot@rev` 不可变；最新版只是一个指针。

* `GET /workbooks/:id/meta`

  * 返回：`{ id, latestRev, latestEtag, latestSnapshotUrl, updatedAt, canEdit }`
* `GET /workbooks/:id/snapshots/:rev`

  * 返回：压缩后的 `IWorkbookData` JSON
  * 头：

    * `ETag: "<sha256>"`
    * `Cache-Control: public, max-age=31536000, immutable`
    * 支持 `If-None-Match` → 304
* （可选）`GET /workbooks/:id/snapshots/latest` → 302 到 `.../:rev`（或直接返回同内容）

> 好处：未来 OT/checkpoint 也天然是 checkpoint@rev；分块(tile)同理可设计为不可变资源。

---

### 4) Cap’n Web API 设计（控制面，最小可用且可拓展）

Cap’n Web 提供 object-capability + 双向调用 + pipelining，非常适合作为“Session/WorkbookHandle”。([blog.cloudflare.com](https://blog.cloudflare.com/capnweb-javascript-rpc-library/))

#### 4.1 Session（能力对象）

* `openWorkbook(id)` → `{ latestRev, latestSnapshotUrl, latestEtag, canEdit, autosavePolicy }`
* `beginSave({ id, baseRev, sha256, byteSize })`

  * 成功 → `{ uploadUrl, uploadId, commitToken, currentRev }`
  * 冲突 → `{ conflict: true, currentRev, latestSnapshotUrl }`
* `commitSave({ id, uploadId, commitToken })` → `{ newRev, newSnapshotUrl, newEtag }`
* （预留）`subscribeWorkbook(id)`（未来推送/协作）

---

### 5) 保存工作流（两段式，兼顾 capnweb 优势与 HTTP 优势）

**动机**：快照是大对象，走 HTTP 更好；但并发控制/权限/事务编排用 capnweb 一轮多行为更合适。

1. 前端：`snapshot = fWorkbook.save()` 获取最新 `IWorkbookData`。([docs.univer.ai](https://docs.univer.ai/guides/sheets/features/core/sheets-api))
2. 前端：`json = JSON.stringify(snapshot)`；算 `sha256`（或服务端算）。
3. capnweb：`beginSave(baseRev, sha256, size)`

   * 若 `baseRev != currentRev` → 冲突，提示刷新（MVP 不自动合并）
4. HTTP：`PUT uploadUrl` 上传 blob（可 gzip/br）
5. capnweb：`commitSave(uploadId, commitToken)`

   * 服务端：校验 hash/大小、落库、`rev++`，更新 meta.latestRev
6. 前端：更新 `baseRev=newRev`、dirty=false

---

### 6) 打开与加载流程（利用缓存）

1. capnweb：`openWorkbook(id)` 拿到 `{latestRev, snapshotUrl, etag}`
2. HTTP GET `snapshotUrl` with `If-None-Match: etag`

   * 304 → 用本地缓存（浏览器 cache/IndexedDB）
   * 200 → 解压 JSON → `univerAPI.createWorkbook(snapshot)`([docs.univer.ai](https://docs.univer.ai/guides/sheets/features/core/sheets-api))

---

### 7) 自动保存（MVP 实用策略）

* 用 `univerAPI.onCommandExecuted(...)` 只做 dirty 标记 + debounce 触发保存（2–5s 无操作）。([docs.univer.ai](https://docs.univer.ai/guides/sheets/features/core/general-api))
* 避免高频保存：设置最短间隔（例如 10–20s）+ 最长间隔（例如 60s）双阈值。
* 若编辑态可能未提交到模型：在保存前结束编辑（按你启用的 UI facade 能力做）。相关“结束编辑再读值”在 Range API 指南有提示。([docs.univer.ai](https://docs.univer.ai/guides/sheets/features/core/range-selection))

---

### 8) libsql + Drizzle 存储建议（概念层，不写表结构）

Drizzle 文档确认 SQLite 可用 `libsql` 驱动，libSQL 可连本地 SQLite 或 Turso 远端，并有更强 ALTER/扩展/静态加密能力。([orm.drizzle.team](https://orm.drizzle.team/docs/get-started-sqlite))

存储实体（概念）：

* **WorkbookMeta**：`id, latestRev, latestEtag/hash, updatedAt, updatedBy, formatVersion`
* **SnapshotBlob**：`(id, rev) -> { etag/hash, encoding, blob, size }`（不可变）
* **UploadSession**：`uploadId, commitToken, expiresAt, expectedHash, expectedBaseRev`

压缩：

* MVP：gzip（最少依赖）
* 可升级：zstd（更高压缩率）

并发：

* WAL 模式 + 事务包裹 `commitSave`（检查 baseRev、写 snapshot、更新 meta 一次事务完成）

---

### 9) 为未来拓展预留的兼容性（现在不做，但设计已对齐）

* **OT**：把 `rev` 直接演进为 server revision；capnweb 增加 `submitOps()/subscribeOps()`；checkpoint 仍写 `snapshots/:rev`（HTTP 强缓存）。
* **分块/tile**：新增 `GET /workbooks/:id/tiles/:tileKey@:rev`（不可变）与 `meta` 返回 tile manifest；控制面仍用 capnweb 下发策略与权限。
* **插件数据**：继续放 `resources`，按 Custom Model 的序列化钩子管理。([docs.univer.ai](https://docs.univer.ai/guides/recipes/tutorials/custom-model))
* **避免破生态的底线**：始终通过 command/Facade 改模型，不直接改 snapshot。([docs.univer.ai](https://docs.univer.ai/guides/sheets/getting-started/quickstart))

---

### 10) 最小实现清单（按优先级）

1. HTTP：`/meta`、`/snapshots/:rev`、`upload PUT`
2. Capnweb：`openWorkbook`、`beginSave`、`commitSave`
3. 前端：createWorkbook、save、rev 乐观锁、dirty+autosave（commandExecuted 监听）([docs.univer.ai](https://docs.univer.ai/guides/sheets/features/core/general-api))
4. 存储：meta + snapshot@rev（不可变）+ upload session

