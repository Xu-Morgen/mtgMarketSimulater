# Achievements Module

拥有成就定义、进度、不可变解锁、奖励发放与每日风控。只消费已结算的 `tournament.settled` 事实事件，
绝不回写赛事、经济、库存或市场真相；浏览器与 AI 只读取成就结果，不能解锁或发奖。

成就规则位于 `@mtg-market/rules` 的 `achievement-rules.ts`；本模块只做事务编排、来源持久化与审计。
