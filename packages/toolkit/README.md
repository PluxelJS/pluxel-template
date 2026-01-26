# @pluxel/toolkit

一个给 Pluxel 生态内部复用的“工具包”工作区：把常用第三方库收拢到一个依赖里，避免每个插件/包重复安装与版本漂移。

这些依赖会在构建时被打包进 `dist`（`minify` + `treeshake`），使用方只需依赖 `@pluxel/toolkit`。

## 子路径导出

- `@pluxel/toolkit/pacer`：完整再导出 `@tanstack/pacer`
- `@pluxel/toolkit/cache`：再导出 `lru-cache` + `@neophi/sieve-cache`
- `@pluxel/toolkit/id`：再导出 `nanoid`
- `@pluxel/toolkit/hash`：再导出 `rapidhash-js` + 轻量封装 `rapidHash64Hex()`
- `@pluxel/toolkit/ohash`：再导出 `ohash`
- `@pluxel/toolkit/time`：内部实现（轻量）`parseDurationMs()` / `formatDurationMs()` / `sleep()`
- `@pluxel/toolkit/option`：聚合导出（轻量转发）`option-t` 的常用入口（Maybe/Nullable/Undefinable/Result）

## 使用

```ts
import * as pacer from '@pluxel/toolkit/pacer'
import * as cache from '@pluxel/toolkit/cache'
import * as option from '@pluxel/toolkit/option'
import { nanoid } from '@pluxel/toolkit/id'
import { hash as stableHash } from '@pluxel/toolkit/ohash'
import { rapidhash, rapidHash64Hex } from '@pluxel/toolkit/hash'
import { parseDurationMs, sleep } from '@pluxel/toolkit/time'
```

## 能力说明（给 LLM/人类快速扫一眼）

本包的目标是：**轻量、可 tree-shake、子路径清晰**。每个子路径要么“再导出上游”，要么“内部实现”（会注明）。

- `pacer`（再导出）：轻量“定时/调度”工具集，覆盖：
  - Debounce：`debounce()`/`asyncDebounce()` + `Debouncer`/`AsyncDebouncer` + `debouncerOptions`/`asyncDebouncerOptions`
  - Throttle：`throttle()`/`asyncThrottle()` + `Throttler`/`AsyncThrottler` + `throttlerOptions`/`asyncThrottlerOptions`
  - Rate Limit：`rateLimit()`/`asyncRateLimit()` + `RateLimiter`/`AsyncRateLimiter` + `rateLimiterOptions`/`asyncRateLimiterOptions`
  - Queue：`queue()`/`asyncQueue()` + `Queuer`/`AsyncQueuer` + `queuerOptions`/`asyncQueuerOptions`（含 `QueuePosition`）
  - Batch：`batch()`/`asyncBatch()` + `Batcher`/`AsyncBatcher` + `batcherOptions`/`asyncBatcherOptions`
  - Retry（async）：`asyncRetry()` + `AsyncRetryer` + `asyncRetryerOptions`
  - 事件/工具：`pacerEventClient`、`isFunction`、`parseFunctionOrValue`、以及各类 `*Options/*State` 类型
- `cache`（再导出）：`LRUCache`（来自 `lru-cache`）+ `SieveCache`（来自 `@neophi/sieve-cache`）
- `id`（再导出）：`nanoid()` / `customAlphabet()` / `urlAlphabet`（来自 `nanoid`）
- `ohash`（再导出）：稳定序列化/对象哈希与比较：`serialize()` / `hash()` / `isEqual()` / `digest()`（来自 `ohash`）
- `hash`（再导出 + 轻量封装）：快速 64-bit hash：`rapidhash()`/`rapidhash_fast()`/`rapidhash_protected()`（来自 `rapidhash-js`，返回 `bigint`）+ `rapidHash64Hex()`（`bigint` → 16 hex chars）
- `time`（内部实现）：`parseDurationMs('1s' | '2m' | '3h' | '4d' | '500ms')`、`formatDurationMs(60000) => '1m'`、`sleep(50)`
- `option`（聚合转发）：`option-t` 的 `maybe/nullable/undefinable/plain_result`（它本身也是为 treeshake 设计的函数式 API）
