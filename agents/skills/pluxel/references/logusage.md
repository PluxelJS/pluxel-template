# 写日志（LogTape）— 快速规则

只要你改了 `logger.*` 调用，就先对齐本文。深度审计再开 `references/logusage.full.md`。

## 先选调用形式

- 纯文本（不需要可查询字段）：``logger.info`Loaded ${id}```
- 需要字段（后续要过滤/展示/工具消费）：`logger.info("Loaded {id}", { id })`
- 只想记录结构化属性：`logger.debug({ id, ms })`（不 lazy）
- 有开销（字符串拼接/序列化/大对象）：lazy
  - `logger.debug((l) => l\`Snapshot ${expensive()}\`)`
  - `logger.debug("ctx {*}", () => ({ meta: expensiveMeta() }))`

## 硬规则

- 需要字段就用 structured（message + properties）；不需要字段就别传 properties
- 任何“可能很贵”的内容都要 lazy（不要在 log 语句里提前算）

## 错误对象（formatter 负责）

- 禁止把 error 拼进 message（包括模板字符串）：
  - 禁止：``logger.error`failed: ${error}``` / `logger.error("failed: {error}", { error })`
- 只能作为结构化属性传入，key 必须是 `error` 或 `err`：
  - 允许：`logger.error("failed", { error })`

## 快速 review 搜索

```bash
rg -n "logger\\.\\w+`" .
rg -n "logger\\.\\w+\\(\\s*\\{[\\s\\S]*\\}\\s*\\)" .
```
