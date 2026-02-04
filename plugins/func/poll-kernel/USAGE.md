# Poll Kernel Usage

## 安装

```ts
import { plugins as mikroOrmPlugins } from 'pluxel-plugin-mikro-orm'
import { plugins as pollPlugins } from 'pluxel-plugin-poll-kernel'
```

## 基础示例

```ts
import { BasePlugin, Plugin } from '@pluxel/hmr'
import { PollKernel, type PollSpec, buildSelection } from 'pluxel-plugin-poll-kernel'

@Plugin({ name: 'PollCaller', type: 'service' })
export class PollCaller extends BasePlugin {
	constructor(private readonly polls: PollKernel) {
		super()
	}

	async demo() {
		const spec: PollSpec = {
			mode: 'single',
			choices: [
				{ id: 'a', label: 'A' },
				{ id: 'b', label: 'B' },
			],
		}

		const { pollId } = await this.polls.createPoll(spec, {
			requestId: 'admin-1',
			now: Date.now(),
		})

		await this.polls.castVote(pollId, ['a'], {
			principalId: 'user-1',
			requestId: 'vote-1',
			now: Date.now(),
		})

		await this.polls.mutateBatch(pollId, [
			{ type: 'cast', selection: ['b'], ctx: { principalId: 'user-2', requestId: 'vote-2', now: Date.now() } },
			{ type: 'cast', selection: ['a'], ctx: { principalId: 'user-3', requestId: 'vote-3', now: Date.now() } },
		])

		const selection = buildSelection(spec, ['a'])
		if (typeof selection !== 'string') {
			await this.polls.castVote(pollId, selection, {
				principalId: 'user-4',
				requestId: 'vote-4',
				now: Date.now(),
			})
		}
	}
}
```

## requestId 的意义（必须阅读）

`requestId` 是写请求的幂等键，用于避免重复计票：

- `(pollId, requestId)` 必须全局唯一（由数据库唯一索引保证）。
- 首次出现：请求被接受并写入。
- 重放或重复：返回历史结果（code 与首次一致），不会再次修改计分。
- 同 requestId 不同 payload：返回 `IDEMPOTENT_MISMATCH`。

建议：
- 同一请求的重试必须复用同一个 `requestId`。
- 不同请求必须使用新的 `requestId`。
- `requestId` 不是鉴权字段，不代表用户身份。

## API 概览

- `createPoll(spec, ctx)` → `{ pollId }`
- `castVote(pollId, selection, ctx)` → `Decision`
- `retractVote(pollId, ctx)` → `Decision`
- `closePoll(pollId, ctx)` → `Decision`
- `getResults(pollId, now)` → `ResultsSnapshot | null`
- `mutateBatch(pollId, reqs)` → `Decision[]`

`ResultsSnapshot` 返回：
- `counts[i]`：选项 i 的人数
- `totals[i]`：选项 i 的加权得分

### Selection 输入

`castVote/mutateBatch` 的 `selection` 支持：

- `string[]`：使用 choice id 列表（由内核解析/校验）
- `Selection`：预解析后的结构体（`buildSelection` 可生成）

```ts
const selection = buildSelection(spec, ['a'])
if (typeof selection !== 'string') {
	await polls.castVote(pollId, selection, ctx)
}
```

### 批量写

`mutateBatch` 会在单事务内处理多条请求，减少锁争用与往返。
若 batch 内出现重复 `requestId`：

- payload 相同：返回之前的结果（回放）
- payload 不同：返回 `IDEMPOTENT_MISMATCH`

## 配置

```ts
PollKernelConfigSchema = {
  scopeKey?: string              // 表前缀 scope（默认 plugin id）
  ensureSchema?: boolean         // default true
  dropTableOnDispose?: boolean   // default false
  specCacheSize?: number         // default 1024
  enableInProcessQueue?: boolean // default true
  snapshotCacheSize?: number     // default 2048 (0 = disable)
  queueCacheSize?: number        // default 4096
}
```
