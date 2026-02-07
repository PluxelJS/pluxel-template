# pluxel-plugin-univer-ai

Univer 的 AI service 插件（service-only）：对接 `pluxel-plugin-llm-hub`（LLM 调用）+ `@pluxel/promptkit/toon`（结构化上下文编码），产出 ChangeSet（结构化变更建议）。

- 依赖：`pluxel-plugin-llm-hub`（LLM 调用）+ `@pluxel/promptkit/toon`（TOON 编码）
- 输出：结构化 **ChangeSet**，由前端在 Univer 编辑器中预览/勾选后，通过 Facade/Command 应用（后端不直接改 snapshot）

## Usage

1) 确保 `pluxel-plugin-llm-hub` 已配置默认 profile（在它的 UI 里配置 provider/model/key）。
2) 在 `pluxel.hmr.jsonc` profile 中启用 `pluxel-plugin-univer-ai`（本 repo 已默认加入 `default/univer`）。
3) 打开 Univer 编辑页，点击右上角 `AI` 打开面板，选区后点击“生成建议”。

RPC：

- `UI.rpc.UniverAI.suggestEdits(input) -> { changeSet, meta? }`

Notes:
- `input.context.format` 支持 `json` / `toon`；若传 `toon`，后端会直接使用该 TOON 文本作为上下文（跳过 JSON parse）。
- `meta.llmProfile` 会返回本次请求最终选中的 LLM profile（来自 `pluxel-plugin-llm-hub` 的选路结果），便于在 UI 上做 debug/观测。

设计说明：`DESIGN.md`
