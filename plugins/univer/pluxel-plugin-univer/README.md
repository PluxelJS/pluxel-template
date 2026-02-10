# pluxel-plugin-univer

Univer 的核心后端/服务插件：管理“前端需要启用的 Univer 插件 spec”，并通过 SSE 推送给独立前端。

## Responsibilities

- 维护可序列化的 Univer 插件开关集合（`pluginKey + config`）
- 通过 SSE namespace `univer:plugins` 推送 `snapshot/upsert/remove`
- 汇总“后端功能可用性/开关”（Capabilities），通过 `UI.rpc.Univer.capabilities()` 提供给前端（用于入口开关、debug 面板等）
- 可选：基于自身 config 启用默认能力（例如 watermark）

## Frontend

前端已拆为独立 Vite 应用：`apps/univer-web`。

## Protocol

共享 payload/type 定义在：`packages/univer-protocol`（`@pluxel/univer-protocol`）。

## Config

基础能力建议直接收敛到核心配置里（避免拆成过多小插件）。当前内置：

- `watermark.enabled`（默认 `true`）
- `watermark.content`（默认 `Pluxel × Univer`）
- `watermark.fontSize`（默认 `36`）
