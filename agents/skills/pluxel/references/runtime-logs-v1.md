# Runtime Logs V1（语义约束，必读）

当你改的是“日志存储/流式传输/游标语义”（而不是普通 log callsite），必须先对齐下面这些约束，否则 UI/MCP/工具会被悄悄破坏。

## 你在改什么

- **Log callsite**（`logger.info(...)` 这些调用形式）→ 看 `references/logusage.md`
- **Runtime Logs**（store / range / follow / SSE / cursor）→ 看本文

## 核心不变量（不要破坏）

1) **epoch + seq**
- 每条记录都有 `epoch` 与 `seq`
- **epoch 重置**表示一次“全量 reset”（例如 store 清空/重建）
- 同一 epoch 内 `seq` 单调递增（append-only）

2) **cursor 是“扫描游标”，不是“返回条目数”**
- `range.nextSeq` 的含义是“下一次从哪里继续扫描”
- 不要把它当成“这次返回的最后一条 + 1”

3) **follow（SSE）事件序列必须稳定**
- 连接后应该先有一个明确的 `reset`（或等价信号），再 catch-up，再 append
- 允许 `gap`（代表中间缺失/跳跃），但语义要一致可恢复

4) **virtual streams**
- `plugin:<id>` / `context:<x>` 这类 stream 通常是对默认 store 的“虚拟视图”
- 不要为每个 plugin/context 创建独立 store（会导致爆炸式状态与难以回收）

## 交付面（你必须一起检查的消费者）

改动 runtime logs 语义后，至少要一起检查：
- 任何 “range / follow” 的调用方（UI / API / MCP / tests）
- 文本格式化输出（LLM-friendly text）是否仍可读且可 cursor follow

## 快速定位（跨项目通用）

当项目里没有固定目录结构时，用搜索而不是写死路径：

```bash
rg -n "Runtime Logs V1|streams/.*/range|streams/.*/follow|nextSeq|virtual streams|plugin:|context:" -S .
rg -n "logs\\.latestText|logs\\.waitForText|/api/logs|/api/mcp" -S .
```

