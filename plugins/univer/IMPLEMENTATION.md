# Univer 当前实现说明（workspace）

本文件用中文说明目前仓库里 Univer 相关实现现状与目录结构，重点覆盖
`plugins/univer/packages`。

## 目前已实现的内容

- 核心服务插件 `pluxel-plugin-univer`：维护可序列化的 Univer 插件 spec，
  通过 SSE 推送到前端，并聚合能力提供者形成统一 RPC。
- 工作簿服务插件 `pluxel-plugin-univer-workbooks`：提供数据面（HTTP）
  与控制面（RPC），涵盖文件夹/文档管理与快照保存流程。
- `@pluxel/univer-headless`：提供 headless 引擎与最小 AI tool-call bridge，
  并在 `protocol` 子路径统一导出 SSE/RPC/AI 合约与工作簿检查等共享类型
  （`@pluxel/univer-headless/protocol`）。

## packages 目录结构（重点）

```
plugins/univer
  univer-headless/
    src/
      protocol/
        primitives.ts     # Workbook/Sheet/Range 等基础类型
        tools.ts          # 工具组/预设/策略 + MCP 工具输入输出类型
        ai.ts             # AI 能力、上下文与 SSE 事件结构
        capabilities.ts   # 能力快照通用结构
        plugins.ts        # Univer 插件 spec + SSE payload
        loopback.ts       # loopback 执行入参/出参
        rpc.ts            # RPC surface 定义
        workbook.ts       # workbook 检查结构
        index.ts          # protocol 导出（子路径）
      ai/
        a1.ts           # A1 解析工具
        ax.ts           # AxFunction loopback 工具与执行（支持 tool preset）
        bridge.ts       # headless AI tool-call 实现
        mcp/            # MCP 风格工具（按领域拆分）
          context.ts    # 共享上下文与约束
          data.ts       # 数据读写与搜索（含 schema）
          sheets.ts     # 工作表管理（含 schema）
          structure.ts  # 行列/合并等结构操作（含 schema）
          style.ts      # 基本样式操作（含 schema）
          utils.ts      # 通用解析与反射调用
      headless-engine.ts
      index.ts
```

## 其它 Univer 关键目录

```
plugins/univer/
  pluxel-plugin-univer/            # core SSE + capabilities
  pluxel-plugin-univer-workbooks/  # workbooks 数据/控制面
  README.md                        # 设计说明（非实现）
  MVP.md
```

## 最近的整理点

- protocol 重整为扁平结构：`primitives/tools/ai/plugins/loopback`，降低跨文件跳转成本。
- headless 的 AI 工具仍统一放在 `univer-headless/src/ai/`，与引擎主体分离。

## Headless MCP 已实现的工具（精选）

数据类：
- `set_range_data` / `get_range_data`
- `search_cells`
- `auto_fill`
- `format_brush`（依赖 Univer Range 的样式 API，缺失则抛错）
- `set_range_style`

工作表管理：
- `get_sheets` / `get_active_unit_id`
- `create_sheet` / `delete_sheet` / `rename_sheet`
- `activate_sheet` / `move_sheet` / `set_sheet_display_status`

结构操作：
- `insert_rows` / `insert_columns`
- `delete_rows` / `delete_columns`
- `set_cell_dimensions`
- `set_merge`

工具类：
- `get_activity_status`

默认只注入最常用工具（`set_range_data` / `get_range_data` / `search_cells`）。
工具选择由 `toolPolicy` 依据目标与指令自动挑选（按领域扩展），并支持显式 preset：
- `core`：读写/搜索
- `data`：自动填充
- `sheet`：工作表管理
- `structure`：行列/合并/尺寸
- `style`：样式/格式刷
- `all`：全部工具组
工具目录与关键词/preset 统一在 `univer-headless/src/ai/mcp/catalog.ts`。
默认在 LLM context 中注入工具索引（按当前选中组列出工具），可用
`toolPolicy.toolIndex = 'none' | 'groups' | 'tools'` 控制注入强度。
复杂任务仍推荐逐步扩展工具组，避免单轮 context 爆棚。

示例（按目标选择工具组）：
```ts
toolPolicy: {
  goal: '格式化表头并加粗',
  prefer: ['style'],
  allow: ['core', 'style'],
  maxGroups: 2,
}
```

示例（结构修改 + 样式，允许更多工具组）：
```ts
toolPolicy: {
  goal: '插入两行并合并表头',
  prefer: ['structure'],
  allow: ['core', 'structure', 'style'],
  maxGroups: 3,
}
```

未覆盖的官方 MCP 能力（可按需补）：
- 条件格式规则（add/set/delete/get）
- 数据验证规则（add/set/delete/get）
- `scroll_and_screenshot`
