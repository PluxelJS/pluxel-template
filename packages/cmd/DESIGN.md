# @pluxel/cmd（内部代号：cmdkit）

cmdkit 是 `@pluxel/cmd` 这套内核与 API 的内部代号，用来强调它是“可复用的执行内核”，避免和 `cmd()` 这个 builder 名字混淆。

本文描述的是 **真实实现的边界与不变量**（schema/exec/text/router/mcp），尽量避免复制粘贴类型签名（那会漂移）。

## 1. 目标与非目标

**目标**
- 提供可独立复用的 command/op 执行内核：`candidate → input → output`。
- schema-first：以 TypeBox(JSON Schema) 做输入/输出校验与（可选）text grammar 派生。
- text：从 input schema 派生一套稳定、可推理的 flags 语法（而不是手写 argv parser）。
- 拦截器：phase-based lifecycle，热路径低分配、控制流可推理。
- 可观测：`ctx.emit` / `ctx.span`，由上层决定如何渲染/转发。

**非目标**
- 不提供平台层能力：权限/限流/存储/DI/HMR/插件生命周期/日志系统实现。
- 不内建 timer：取消/超时由上层提供（`AbortSignal` / `deadlineMs`）。
- 不做富文本/前缀解析/复杂 positionals：text 语法只围绕 schema 派生的 keyed params + 可选 tail。

## 1.1 分层（core / kit / downstream）

为了让上层（例如 bot-suite）只做“增量而不是另起一套体系”，`@pluxel/cmd` 按层拆分：

- **core（内核）**：schema/exec/text/mcp/router，不包含任何平台策略。
  - core 的 builder/router 属于“可复用内核”，不作为 public API 暴露（避免上游出现两套用法）。
- **kit（组合层 / public）**：`Cmd.createSpace()` + `space.scope(scopeKey)`（唯一推荐入口），内部包含：
  - `command/op/defs/group/when` DSL
  - `CommandRegistry + router`（共享空间）
  - `tail.*`（ParseBox tail 辅助）
  - 默认 **MCP-first**：非 `doc.internal` 的命令/工具默认暴露 MCP tool（可用 `.mcp(false)` 关闭）。
  - spec 的 `ext` 扩展袋：下游在 install 阶段读取（权限/限流/产品埋点等），不需要 fork cmd 体系。
- **downstream（产品层）**：只实现自己的 `decorate()`（拦截器/声明/列表字段补全），并通过 `.ext({...})` 携带产品元数据。

## 2. 核心不变量（少且硬）

1) **取消与超时由上层提供**：核心只消费 `ctx.signal` / `ctx.deadlineMs`（不创建 timer）。

2) **扩展点用 phase-based interceptor，不用 `next()` middleware**：固定生命周期点更可推理，也更容易做低分配实现。

3) **unwind 阶段逆序执行**：`afterOutput/onError/finally` 逆序；`before/afterInput` 正序。获得“栈语义”（先进入后退出）。

4) **interceptor 私有 state 通道**：`before` 产出的 state 仅供同一个 interceptor 后续阶段使用，避免把状态塞进共享 ctx。

5) **严格的阶段能力边界**：哪些阶段允许短路/变换/恢复都写死，避免控制流滑回“隐式 middleware 地狱”。

## 3. 执行模型（candidate → input → output）

命令自然生命周期：
- `candidate (unknown)`：来自上游（JSON 调用 / text 解析）。
- `input (validated)`：通过 input schema + 自定义校验后得到的强类型输入。
- `output (validated)`：handler 产出结果，按需经过 output schema + 自定义校验。

拦截器阶段（固定且少）：
- `before(candidate)`：可拒绝、可改写 candidate、可 short-circuit 直接给出 outputCandidate。
- `afterInput(input)`：只观测；不允许改写 input（要改写请在 schema/handler 或 `before`）。
- `afterOutput(output)`：允许轻量变换 outputCandidate（脱敏/envelope），逆序执行。
- `onError(err)`：默认只观测，逆序执行；只有声明 `canRecover=true` 的 interceptor 才允许恢复为 outputCandidate。
- `finally(summary)`：只清理/观测，逆序执行；不得改写结果。

## 4. Schema：TypeBox + strict-by-default + default 注入

### 4.1 TypeBox 是“唯一 schema 语言”

cmdkit 的 `Schema` 直接使用 TypeBox 的 `TSchema`；同时会在必要时把 schema 序列化为 JSON Schema 视图：
- 校验：TypeCompiler 编译的 validator。
- text 派生：从 JSON Schema（对象 properties）派生 params 表。
- MCP：输出 data-only 的 tool definition（name/description/inputSchema/outputSchema?）。

### 4.2 strict object 的默认策略

TypeBox 对 object 的 `additionalProperties` 默认是 `true`。在 cmdkit 里，object 很常见地被用作“参数包”，因此：
- **当 object schema 省略 `additionalProperties` 时，cmdkit 会把它规范化成 `additionalProperties: false`（严格模式）**。
- 这个规范化是 **深度** 的：嵌套对象同样遵循 strict-by-default。
- 若要允许未知 key：显式设置 `additionalProperties: true`，或使用 `openObj(...)`。

### 4.3 default 注入

输入/输出校验时会应用 TypeBox 的 `default`：
- 对于缺省字段，会在校验阶段被填充默认值（避免 handler 里充斥 `??`）。
- 实现上会 clone value 并运行 TypeBox `Value.Default(...)`，避免污染上游对象引用。

## 5. Text：schema 派生 flags + 可选 tail

`text()` 是唯一入口：启用后产物会有 `execText(text)`，并携带用于路由/帮助的 `meta`（triggers/params/tail）。

Builder 的少量语法糖（仅为减少样板代码，不改变语义）：
- `.inputObj(props, opts?)` / `.outputObj(props, opts?)`：等价于 `input(obj(props, opts))` / `output(obj(...))`
- `.inputOpenObj(props, opts?)` / `.outputOpenObj(...)`：等价于 `openObj(...)`

类型层面：`Executable.execText` 在基础接口上是 optional（因为不是所有命令都启用 text），但对 `.text().build()` 的返回值会被收窄为“必有 execText”的交叉类型；如果上层把它宽化成 `Op/Executable`，那访问时就会看到 optional，需要通过 `TextOp` 或 `isTextExecutable(...)` 重新收窄。

`meta.params`（`ParamSpec[]`）除了 canonical `name/type/...` 外，还会携带 `inputKey`（schema 的原始字段名），方便上层把 help/表单映射回真实 input。

### 5.1 triggers 匹配

- `text({ triggers })` 省略时默认 `[id]`。
- trigger 支持空格分词；匹配时采用“最长匹配”。

### 5.2 参数派生（object input）

当 input schema 是 object 时，cmdkit 从 JSON Schema 派生 params：
- canonical name：从 input key 生成 kebab-case（例如 `userId → user-id`）。
- long alias：默认接受 kebab/camel/snake 等常见变体（只在不冲突时生效）。
- short：默认从参数名自动派生（冲突则不生成）。
- boolean：支持 `--no-<name>` negation。
- 数组：repeat / comma / JSON array。
- json：`JSON.parse(...)`（object-typed，即 JSON Schema `type: "object"`）。

保留字：
- input schema 的 property key `_` 被保留（避免和 tail 的概念混淆）；出现会在 build-time 抛错。

补充：cmdkit **不会强制所有 input 都是 object**。
- 对于一些“单值输入”的命令（例如 `echo <text...>` / `sleep <ms>`），用 `Type.String()` / `Type.Number()` / `Type.Boolean()` 能得到更小的 schema、也更贴近 MCP/tool calling 的数据形态。
- 在 text 模式下，primitive input 不支持 flags；只会把剩余 token 作为一个值（join/parse）传入 handler。
- `tail` / `tailTo` 只对 object input 有意义，因此仅在 object input schema 下允许启用。

### 5.3 显式覆盖（schema extension keys）

为了让复杂命令更可控，cmdkit 支持在 property schema 上附加扩展字段（JSON Schema extension keys）：

- `x-cmd-aliases: string[]`  
  额外 long aliases（不带 `--` 前缀）。这类 alias 是 **hard** 的：
  - 与任何 canonical/alias 冲突都会在 build-time 抛错（避免解析歧义）。

- `x-cmd-short: string | null | false`  
  显式 short（单个字母），或禁用自动 short：
  - 显式 short vs 自动 short：**显式优先**，自动会被丢弃。
  - 显式 short 冲突（多个参数声明同一个 short）：build-time 抛错。

### 5.4 语法（object input）

支持的 keyed 语法：
- `--key value` / `--key=value`
- `key:value` / `key=value`
- `--no-key`（boolean）
- short：`-c value` / `-c=value` / `-cVALUE`（附着值）
- short bundling：`-abc`（仅 boolean）
- short boolean value：`-f false`

错误策略：
- unknown params 不会被忽略（报 `E_TEXT_PARSE`），并在多数情况下给出“did you mean …”建议（canonical 名称）。

### 5.5 Tail（可选）：`tailTo` 或 ParseBox `tail`

tail 的目标是“让 DSL/剩余文本存在”，但仍保持 schema-first 的主语义：
- keyed params 仍然来自 schema 派生；
- tail 是 text-only（不会污染 MCP 的 input schema）。

cmdkit 提供两种 tail：

1) **raw tail**：`text({ tailTo: '<inputKey>' })`  
把“剩余文本”（trim 后）直接写入某个 input 字段，零依赖、适合“expr/filter”这类简单场景。

2) **ParseBox tail**：`text({ tail })`  
把“剩余文本”交给 ParseBox 解析，要求它返回 **object patch**，合并进真实 input。

共同规则（不引入歧义）：
- `--` sentinel 明确开始 tail：`cmd -- <tail...>`
- 否则，tail 从第一个“非选项 token”开始
- implicit tail 模式下：若 tail 内出现“看起来像已知 keyed param”的 token，会报错，要求用 `--` 显式开始 tail
- tail 不允许覆盖已通过 keyed params 提供的字段（避免两个输入源同时写同一个 key）

ParseBox 细节：
- 调用 ParseBox 时会在 tail 文本末尾追加一个 `\n`，因此 `Runtime.Until(['\n'], ...)` 可作为“读到行尾”。

## 6. MCP：MCP-first（可关闭）的 data-only 元数据

cmdkit 的 MCP 元数据是 **data-only**（不携带实现），用于把同一份 schema/doc 复用到 tool calling 层。

默认策略（MCP-first）：
- 对于 `doc.internal !== true` 的 command/op：默认会暴露 MCP tool（等价于 `.mcp({})`）。
- 对于 `doc.internal === true`：默认不暴露（等价于 `.mcp(false)`）。

覆盖方式：
- `.mcp(false)`：显式关闭 MCP tool 暴露。
- `.mcp({ ... })`：自定义 `name/title/description/...` 等字段。

设计要点：
- `exec.mcp` 是 data-only：`name/title/description/inputSchema/outputSchema?`。
- `title/description` 省略时可从 `doc.title` / `doc.description` 默认填充（更利于复用同一份 doc）。
- 输出 schema：
  - 你可以手动提供 `outputSchema`；
  - 或在 `.output(schema)` 存在时使用 `deriveOutputSchema: true` 派生。

## 7. Router：tokenize + match + dispatch

router 是 text-first 路由实现（由 `CommandRegistry` 内部持有，并经由 `Cmd.createSpace()` 暴露 `dispatch()` 能力）：
- 匹配：基于 triggers 的 token 前缀树，最长匹配。
- dispatch：支持 `dispatch(text)` 和 `dispatchTokens(tokens)`；后者可复用既有 tokenization。
- help：`helpIndex()` / `helpCommand(name)` 只返回“渲染原材料”（渲染由上层决定）。

配置：
- `caseInsensitive`：仅影响 trigger 匹配（不是 long flags）。
- `maxTextLength`：tokenize 前的安全上限（默认 16 KiB）。

## 8. 性能与可维护性

实现层面的关键点：
- validator 编译缓存（TypeCompiler）与 input model 派生缓存（WeakMap）。
- text 计划在 `.build()` 时编译（热路径只做 tokenize/match/parse + 执行计划）。
- 不创建 timer；取消/超时检查是纯函数 + 分支（由上层决定是否启用）。

关于“为什么不是 `.handle(...)` 之后自动 build”：
- `build()` 是一个显式的“配置结束点”，会触发 text 计划编译、MCP 元数据编译等 build-time 工作。
- 保持显式结束点能减少隐式副作用（例如链式里某一步骤突然变成“编译产物”），也更利于代码检索与约束（lint/代码规范）。
