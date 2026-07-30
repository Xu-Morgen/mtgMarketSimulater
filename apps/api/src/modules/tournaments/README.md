# Tournaments Module

拥有每日赛事、NPC 对手、报名、确定性赛果、奖励与可重放信息。赛事结算只追加 `tournament.settled` 事实；I26B 才能以幂等消费者解锁成就，I33 才会消费已结算摘要生成叙事。
