# Achievement API

只读成就查询路由。HTTP 层只做鉴权、参数校验与响应映射；所有解锁/发奖/审计在 `achievement.process` 任务与 application 内完成。

- `GET /v1/achievements`：成就定义 + 当前玩家进度。
- `GET /v1/achievements/unlocks`：当前玩家已解锁成就与来源/奖励流水。
- `GET /v1/achievements/{definitionId}`：单成就详情含来源（fact/aggregate）跳转信息。
