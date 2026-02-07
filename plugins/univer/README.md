# Univer × Pluxel 设计文档（仅保留设计，不含实现）

这份设计的核心点（按你最新意向收敛）：**Univer 前端由核心前端包一次性打包好“所有可能用到的 Univer 前端插件能力”，运行时只做开关与配置**。其它“univer 相关插件”只做后端/服务侧能力，不再承载任何前端实现。

## 目标与约束（必须）

1. **严格前后端分离**：Univer 前端未来要能独立构建/部署；Host/Service 插件不包含任何浏览器实现细节。
2. **只有一个核心与 `ext.ui` 打交道**：仅核心插件（`pluxel-plugin-univer`）调用 `ext.ui.register(...)`；数据/保存等 service 插件（例如 `pluxel-plugin-univer-workbooks`）一律不直接碰 `ext.ui`。
3. **两套插件系统协作**：
   - Univer 插件系统：`univer.registerPlugin(PluginCtor, config?)` +（可选）Facade side-effect 导入。
   - Pluxel 插件系统：运行时开关、依赖管理、`ctx.caller.effects` 回收。
4. **唯一用法（单一 API）**：第三方插件只调用核心插件的一个方法，传入“已经配置好的 Univer 插件安装描述”（不做 `registerXxx(plugin, config)` 双参 API）。
5. **可回收**：调用方 Pluxel 插件卸载时，对应的 Univer 插件必须从 UI 侧消失（核心负责自动解绑）。
6. **只允许前端类**：这条扩展链路只允许浏览器可用的 Univer 插件/模块（禁止 Node-only）。

## 关键事实（为什么“前端全实现”更实用）

第三方 Pluxel 插件通常运行在 Host/Service（Node）侧，而 Univer 的 `PluginCtor` 属于浏览器 bundle 内的代码对象。既然我们希望 Univer 前端能独立部署、同时又希望 API 精要可控，那么最直接的做法就是：

- **前端包静态内置**（bundled-in）所有允许的 Univer 插件能力（以及必要的 facade side-effect 导入），形成一个 compile-time 的 catalog。
- Host -> UI 只发送 **可序列化的开关与配置**（`pluginKey + config`），UI 侧从 catalog 找到 `PluginCtor` 后调用 `univer.registerPlugin(...)`。

因此我们要设计一个“可序列化的 Univer 插件安装描述（pluginKey + config）”，并且保证卸载可回收。

## 最小 API（核心插件对外）

核心插件只暴露一个方法：

```ts
export type UniverConfiguredPlugin = Readonly<{
  /** optional stable id; default should be derived from caller + plugin */
  id?: string

  /** a key in the frontend catalog (e.g. 'watermark') */
  plugin: string

  /** forwarded as univer.registerPlugin(ctor, config) second argument */
  config?: unknown
}>

class UniverPlugin {
  use(plugin: UniverConfiguredPlugin): () => void
}
```

语义：

- `use(...)` 可以被其它插件调用；此时核心会把 disposer 自动绑定到 `ctx.caller.effects`（caller 卸载 => 自动撤销 UI 开关）。
- 核心自身也可以在 `init()` 里基于自身配置调用 `use(...)`；此时 disposer 绑定到核心的 `ctx.effects`。
- caller 插件卸载 => effects dispose => UI 侧必须撤掉对应 Univer 插件（见下文“回收策略”）。

另外，核心插件自身也可以通过 **自身配置** 启用一些默认能力（例如 watermark）。推荐把这类“前端已打包好的能力默认开关”都收敛到核心配置里，而不是拆成独立插件。

## UI 侧行为（核心 UI tab）

核心 UI tab（由核心插件注册到 `ext.ui`）只做三件事：

1) 创建/销毁 Univer App（browser-only）
2) 订阅 SSE `univer:plugins`（snapshot/upsert/remove），维护一份 “期望安装的 Univer 插件集合”
3) 把集合应用到 Univer：对每条安装描述从 catalog 找到 `PluginCtor`，再 `univer.registerPlugin(...)`

> 说明：工作簿列表/快照加载/两段式保存属于数据面与控制面（HTTP/RPC），已拆到 `pluxel-plugin-univer-workbooks`。

## 文档管理（文件夹）

MVP 采用轻量“文件夹/文档”结构用于浏览与组织（类似文件管理器）：

- 文件夹：树结构（`parentId=null` 为 Root）
- 文档：归属某个文件夹（`folderId=null` 为 Root），点击即可进入 Univer 编辑页

### 回收策略（必须明确）

Univer 插件一般是“增量注册（register）”模型；卸载是否可逆取决于插件本身。为了保证 **Pluxel 卸载 => Univer UI 真正消失**，UI 侧采用一个可证明正确的兜底策略：

- **策略 A（最简单、最确定）：重建 Univer 实例**
  - 插件集合发生变化（upsert/remove）时：dispose 当前 Univer App，重新 create，再按集合顺序 register 所有插件。
  - 优点：100% 可回收、通用、无需依赖 Univer 的“卸载插件”能力。
  - 代价：重建成本（可在后续通过 workbook snapshot/restore 优化）。

> 推荐：**upsert 时尽量增量 register**（无需重建）；**remove 时重建**（保证可回收）。性能优化留到实现阶段再评估（是否需要 snapshot/restore）。

## 前端 catalog（核心前端包一次性打包）

既然 Univer 前端本身就是我们提供/构建的（独立部署的前端包/应用），最精要的方案是：把“允许的 Univer 插件”在前端 **静态内置** 成一个目录（catalog），并且这个目录是唯一可信来源：

- 不允许 Host 传任意 `module/export` 让浏览器去动态加载未知代码（更安全、更可控）。
- 对接 API 永远是 `pluginKey + config`；新增前端插件能力 = 更新前端包并重新部署（这正符合“前端独立构建部署”的现实）。

未来如果确实需要“插件不进前端 bundle、运行时按需加载”，再扩展为远程模块即可，但不是默认路径。

## Watermark 示例（符合官方语义）

你给的官方写法本质是：

- `import { UniverWatermarkPlugin } from '@univerjs/watermark'`
- `import '@univerjs/watermark/facade'`
- `univer.registerPlugin(UniverWatermarkPlugin, config)`

在本设计里，watermark 的 Pluxel 插件只需要注册一个“安装描述”：

```ts
import type { IUniverWatermarkConfig } from '@univerjs/watermark'

this.univer.use({
  plugin: 'watermark',
  config: {
    textWatermarkSettings: { content: 'Hello, Univer!', fontSize: 36 },
  } satisfies IUniverWatermarkConfig,
})
```

卸载语义：

- watermark Pluxel 插件卸载 -> `ctx.caller.effects` 自动触发 remove -> UI 收到 remove -> 触发重建 Univer -> watermark 不再被 register。

## 安全边界（只允许前端类）

由于前端包静态内置所有前端能力，这里的边界变成“catalog 只收录 browser-only 的 Univer 插件与 side-effect facade”：

- 允许：`@univerjs/*` 的浏览器插件，以及我们明确标记为 browser-only 的模块
- 禁止：任何 Node-only 入口（例如 `fs`、`node:*` 依赖、服务端 SDK）

## “univer 其它插件只做后端服务”（边界说明）

这类插件的职责只应该是：

- 提供后端数据/权限/协作/存储等服务能力（与 Univer UI 解耦）
- 在需要影响 UI 时，只通过核心 `UniverPlugin.use(...)` 提交“开关/配置”意图

不应该：

- 直接参与 Univer 前端插件实现（不写任何 `univer.registerPlugin(...)` 相关前端逻辑）
- 通过 `ext.ui` 注册 UI（只有核心插件做）

## 核心插件对后端插件的价值（为什么会依赖）

如果某个后端插件**完全不需要影响 Univer UI**，那它确实不应该依赖核心插件。

依赖核心插件的理由只应该来自这一类需求：**后端插件需要把“意图/状态”映射成前端 Univer 的开关与配置**，并且希望这个映射满足 Pluxel 的生命周期与回收语义。核心插件在这里提供的是一个“UI 意图总线 + 运行时一致性层”，典型价值点：

- **唯一对接面**：后端插件只需要调用 `UniverPlugin.use(...)`（单一入口），不用关心 `ext.ui`、SSE、重建策略等细节。
- **生命周期绑定**：通过 `ctx.caller.effects` 保证 caller 卸载时 UI 侧必然撤销（remove -> 重建）。
- **冲突与合并**：多个后端插件同时声明 UI 开关时，核心负责合并成一个“期望集合”（必要时做优先级/命名空间约定）。
- **配置校验与降级**：核心可以对 `pluginKey + config` 做 runtime 校验（或版本协商），避免把无效配置推到 UI 侧导致白屏。
- **可观测性**：统一记录“谁启用了什么 UI 插件、配置是什么、何时 remove/重建”，便于 debug 与审计。

换句话说：核心插件不是“功能实现者”，而是**前端已打包能力的开关/配置入口**；后端插件只有在“需要驱动 UI”时才依赖它。

## 官方参考（链接优先）

- Univer Playground（插件方式）：`https://docs.univer.ai/en-US/playground/sheets/basic-via-plugin`
- Watermark 功能说明：`https://docs.univer.ai/guides/sheets/features/watermark`

## 本仓库实现文档

- 核心前端插件（UI + 编辑器）：`plugins/univer/pluxel-plugin-univer/README.md`
- 文档/保存服务插件（workbooks）：`plugins/univer/pluxel-plugin-univer-workbooks/README.md`
- AI service 插件（Ax + TOON + ChangeSet）：`plugins/univer/pluxel-plugin-univer-ai/README.md`
