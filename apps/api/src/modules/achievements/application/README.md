# Achievement Application

`achievement-service` 是成就事务编排入口：

- `processFactEvent`：任务唯一调用的 fact 消费入口。在 `withLedgerTransaction` 内读取
  `tournament.settled` fact、派生玩家档案（参与/胜场/连胜/指挥官颜色/主导系列/收藏 SKU 数）、
  调用 `@mtg-market/rules` 的 `evaluate*` 与 `evaluateRewardRisk`，原子写入进度、解锁、奖励流水、
  风控计数与审计。重复 fact 或已解锁定义直接幂等跳过，不重复发奖。
- `overview` / `detail` / `unlocks`：只读投影，仅返回服务端已结算结果。

奖励原语经 `users.funds().creditAvailableFunds(reason=achievement_reward)` 或
`inventory.acquireInLedgerTransaction(reason=achievement_reward)` 在同一事务内入账；徽章为不可交易展示物。
