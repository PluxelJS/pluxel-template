# AI plugins

目标：给业务插件一个“最短且不易错用”的 AI 能力入口（LLM / LangChain / Vectors），避免业务直接耦合具体 SDK/实现类。

推荐分层：

1) `pluxel-plugin-llm-hub`：连接/密钥/Vault + 路由/可用性（对外以 token `LLM` 为主）
2) `pluxel-plugin-langchain`：把 connection 适配成 LangChain（token `LangChain`）
3) `pluxel-plugin-vectors`：向量索引与检索（token `Vectors`）

可选适配：
- `pluxel-plugin-llm-hub/adapters/ax`
- `pluxel-plugin-llm-hub/aisdk`

最重要的约束（避免耦合）：
- 业务侧：只依赖 token（`LLM` / `LangChain` / `Vectors`），不要把实现类当依赖类型。
- Host/测试侧：用实现插件注册进 host（例如 `LLMHub` / `LangChainService` / `VectorsLanceDb`），但业务逻辑仍注入 token。

使用建议：业务请求内先通过 `LLM` token 拿到 connection，再按需要选择适配器（LangChain/Ax/AI SDK），并尽量复用同一个 connection 保持一致性。
