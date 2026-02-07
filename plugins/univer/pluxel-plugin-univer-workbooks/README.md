# pluxel-plugin-univer-workbooks

Univer 的“文档数据面 + 保存控制面”插件（service-only）。

- 不注册 `ext.ui`（遵守“只有 core 插件碰 UI”边界）
- 对 UI 提供 **RPC**：文件夹/文档浏览、创建/重命名/删除/移动、两段式保存（begin → upload → commit）
- 对浏览器提供 **HTTP**：按 `rev` 强缓存的 snapshot 读取与 upload PUT

## Data model（MVP）

- Folder：`{ id, name, parentId }`（`parentId=null` 表示 root）
- Workbook：`{ id, name, folderId, latestRev, latestEtag }`（`folderId=null` 表示 root）
- Snapshot：`workbook@rev` 不可变（HTTP 强缓存）

## HTTP（数据面）

前缀：`/api/univer`

- `GET /workbooks/:id/meta`：返回 `latestRev/latestEtag/latestSnapshotUrl/autosavePolicy`
- `GET /workbooks/:id/snapshots/:rev`：返回 JSON snapshot（带 `ETag` + `immutable`）
- `PUT /workbooks/:id/uploads/:uploadId?token=...`：上传 JSON blob（由 beginSave 生成）

## RPC（控制面）

通过 `ctx.ext.rpc` 注册到 `UI.rpc.UniverWorkbooks`：

- 文件夹：`browseFolder/createFolder/renameFolder/deleteFolder`
- 文档：`createWorkbook/renameWorkbook/moveWorkbook/deleteWorkbook/openWorkbook`
- 保存：`beginSave/commitSave`

## Extensibility（未来）

- 权限/多人协作：在 `openWorkbook/beginSave/commitSave` 前后增加鉴权与能力对象即可
- OT/增量日志：保持 `snapshot@rev` 作为 checkpoint，不破坏现有缓存语义
- 大对象/分块：在同一 HTTP 前缀下新增 tiles/attachments，不影响控制面协议

