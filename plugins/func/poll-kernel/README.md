# pluxel-plugin-poll-kernel

一个平台无关的投票内核服务插件，强调：

- **一致性与幂等**：requestId 去重 + 单事务线性化
- **整数权重**：使用 `bigint` 聚合，避免浮点误差
- **Replace 语义**：`castVote` 永远表示“替换我的当前投票”
- **规范化存储**：poll_meta / poll_choice_agg / poll_vote / poll_request
- **平台责任外置**：权限/资格/风控在调用方完成

该实现不是对文档的“机械照搬”，而是结合可维护性与性能折中后的工程实现。

---

用法文档：`USAGE.md`  
设计文档：`DESIGN.md`
