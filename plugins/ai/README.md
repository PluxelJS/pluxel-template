# Pluxel AI 插件栈（使用与设计笔记）

这份文档面向“做业务插件的人”，目标是让你在未来做 RAG / Agent / 工具编排时：
- **知道应该依赖哪个 token**
- **知道边界在哪里（避免耦合/重复实现）**
- **知道推荐的调用姿势（性能 + 一致性 + 可演进）**

当前推荐的分层是三件套：

1) `pluxel-plugin-llm-hub`：LLM 连接与路由（profiles + vault key + priority fallback + circuit breaker）
2) `pluxel-plugin-langchain`：LangChain 适配层（把 hub connection 构造成 LangChain model/embeddings）
3) `pluxel-plugin-vectors`：向量检索服务（默认内嵌 LanceDB；对 embeddings 提供方无感）

并列可选：
- `pluxel-plugin-llm-hub/adapters/ax`：Ax 适配器（把 hub connection 构造成 `AxAI`）
- `pluxel-plugin-llm-hub/aisdk`：Vercel AI SDK provider options helper

---

## 1. 职责边界（最重要）

### 1.0 依赖建议（Consumer vs Implementation）

为了避免业务插件“误用实现类导致耦合”：
- 业务侧（推荐）：只注入/依赖 token（`LLM` / `LangChain` / `Vectors`）。
- Host/测试侧：可以用默认导出的实现插件（`LLMHub` / `LangChainService` / `VectorsLanceDb`）来注册进 host，但业务逻辑仍应注入 token。

结论：**依赖注入时用 token，注册插件时用实现类**；不要在业务代码里把实现类当依赖类型使用。

### `LLMHub`（hub）负责什么？

只负责“连接与可用性”：
- profiles（provider/model/baseURL/options/config）存 pluginData
- apiKey 存 Vault（永远不要落库/日志）
- 路由：`priority` 排序 + 默认允许 fallback（可通过 `allowFallback: false` 禁用）
- 断路器：按 profile 维度记录失败，必要时临时标记不可用

对外稳定 API 只有一个概念：
- `LLMConnection = { profile, apiKey, fetch }`

业务插件应依赖 token：`LLM`（而不是 `LLMHub` 实现类）。

### `LangChain`（langchain 插件）负责什么？

只负责“把一个连接变成 LangChain 模型”：
- `lc.chatModel(...)` / `lc.embeddings(...)`（内部通过 hub 路由拿到连接）
- `lc.resolveChat(...)` / `lc.resolveEmbeddings(...)`（返回 `{ ... , meta }`，用于观测/调试）
- `lc.chatModelFromConnection(conn)` / `lc.embeddingsFromConnection(conn)`（你已经拿到连接时可复用，避免二次路由/Vault 读取）
- `lc.resolveChatFromConnection(conn)` / `lc.resolveEmbeddingsFromConnection(conn)`（同上，但返回 `{ ... , meta }`）
- provider 扩展用 `registerChatFactory/registerEmbeddingsFactory`

注意：LangChain 插件不负责持久化会话，不负责 RAG 编排，不负责 chunking。

### `Vectors`（vectors 插件）负责什么？

只负责“向量索引的增删改查”：
- 默认 LanceDB（本地目录数据库）
- API 以 `vectors.scope().index(name)` 为中心（默认按 caller plugin id 隔离）
- embeddings 提供方无感：只要对象实现 `{ embedDocuments, embedQuery }` 即可（LangChain embeddings 也能直接用）

注意：Vectors 插件不负责 embeddings（那是模型层/适配层），不负责 chunking，不负责 prompt 组装。

---

## 2. 推荐调用姿势（业务侧）

### 2.0 最短接入 checklist

- Host profile 启用：`pluxel-plugin-llm-hub`（以及需要的 `pluxel-plugin-langchain` / `pluxel-plugin-vectors`）
- 在 Host UI 的 `LLM` tab 创建至少 1 个 profile，并在 Vault 设置 apiKey
- 业务插件里只依赖 token：`LLM` / `LangChain` / `Vectors`（不要 new/直连 SDK）

### 2.1 只需要“能调用模型”

最通用：只依赖 hub 的连接形态（SDK-agnostic）。

```ts
const conn = await llm.connection({ traceId, sessionId })
// conn.profile / conn.apiKey / conn.fetch
```

然后你想用哪个生态就用哪个：
- Vercel AI SDK：`toAISDKProviderOptions(conn)`
- Ax：`createAxAIFromConnection(conn, { purpose: 'loopback' })`（后端编排/工具流推荐，禁用 streaming 更稳）
- LangChain：`lc.chatModelFromConnection(conn)`（或 `lc.chatModel()`）

如果你想记录/观测“最终用的是哪个 provider/model”，用 LangChain 的 resolve API：

```ts
const { model: chat, meta } = await lc.resolveChat({ llm: { traceId, sessionId } })
// meta.llmProfile / meta.effective
const out = await chat.invoke('hi')
```

### 2.2 想要“编排/链式/RAG 生态”

用 LangChain，但把“路由/健康/密钥”交给 hub：

```ts
const chat = await lc.chatModel({ llm: { traceId, sessionId } })
const out = await chat.invoke('hi')
```

### 2.3 同一次业务请求里同时用 Ax + LangChain（强一致）

关键点：**先 resolve 一次连接，然后复用它**（避免 fallback 造成不同调用选到不同 profile）。

```ts
const conn = await llm.connection({ traceId, sessionId })

const ai = createAxAIFromConnection(conn)
const chat = await lc.chatModelFromConnection(conn)
```

### 2.4 RAG（最小可落地）

经典形态（embeddings → vectors → chat）：

```ts
const embeddings = await lc.embeddings({ llm: { profileId: 'embeddings-profile' } })
const idx = vectors.index('docs').withEmbeddings(embeddings)

await idx.upsertTexts([{ id: 'c1', text: 'chunk...', metadata: { docId: 'd1' } }])
const hits = await idx.queryText({ query: '...', topK: 5 })
```

建议：把 chunking / rerank / citations 做成单独业务插件或业务模块，不要塞回 vectors/hub/langchain。

实践建议（避免“感觉不优雅”的常见坑）：
- **embedding 模型与 index 强绑定**：同一个 index/table 只能容纳同一维度向量；换 embeddings 模型就新建 index（例如 `docs_openai_text3`）。
- **写入与检索保持同一个 embeddings**：对同一 index，写入/检索必须用同一 embeddings（否则召回质量必崩）。
- **事务型/一致性强的流程禁用 fallback**：例如你要保证“一次请求固定同一 provider”，先 `llm.connection({ allowFallback: false })` 再复用连接。

---

## 3. “解耦 + 高效 + 可演进”的设计原则

### 3.1 只暴露你的业务 DTO，不要把 SDK 类型泄漏成公共 API

如果你写一个业务插件（比如 `pluxel-plugin-rag` / `pluxel-plugin-agent`），对外尽量只暴露：
- `string | JSON` 输入输出
- 你的领域对象（如 `RagAnswer`, `Citation[]`）
- 流式输出（如果需要）

避免把这些类型当成公共返回值：
- `@langchain/*` 的 `Runnable/MessageHistory/...`
- `@ax-llm/*` 的 `AxAI/...`

原因：你未来替换 LangChain/Ax/AI SDK 都不需要破坏业务插件 API。

### 3.2 “唯一真相”放在 hub：连接、路由、断路器、追踪

跨切能力（未来 usage 计费、重试策略、审计、trace）都应该以 `conn.fetch` 为 choke-point。
上层 SDK 只是消费 `fetch/apiKey/baseURL` 组合，不要再包一层“自定义 fetch”。

### 3.3 会话/记忆（memory）不要硬塞进 hub/langchain

推荐做法：
- `sessionId` 贯穿一次业务请求（hub 会把它变成 header）
- 需要持久化就做独立插件：`pluxel-plugin-conversations`（底层用 `Kv` 或 DB）
- LangChain 的 memory 只当“运行时编排工具”，数据源来自你的 conversations 插件

### 3.4 Vectors 的 metadata 设计：先别追求“万能过滤 DSL”

默认 LanceDB 后端目前把 `metadata` 存成 JSON string（避免 schema 演进时炸表）。
这意味着：
- 你可以存任意 metadata（不怕新字段）
- 但不适合做复杂过滤/索引（需要的话应当 materialize 常用字段为独立列，或上层做二次过滤）

如果你确定业务要做过滤：
- 先选 1–3 个高频字段（`docId`, `source`, `tenantId`）做“显式列”
- 其余字段仍放 metadata JSON

---

## 4. 选型建议：Ax vs LangChain 在业务里怎么选？

可以把它们当作“并列 SDK”，按场景选：

- 需要强约束结构化输出/签名式 prompt、轻量 agent：优先 Ax
- 需要 runnable 编排、memory、retriever/tool 生态：优先 LangChain
- RAG 常见做法：Vectors 检索 +（可选 LangChain 做编排）+ Ax/AI SDK 做最终生成

重要：你不需要在基础设施层把它们“合并成一个超级 hub”。
让它们共享 `LLMConnection` 就能做到一致、解耦、可替换。
