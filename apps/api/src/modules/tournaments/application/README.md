# Tournaments Application

实现赛事、赛果、奖励的命令、查询与事务编排用例。负责权限、幂等性、跨模块协作、领域规则调用与审计投递；不依赖 Fastify 细节，也不暴露具体 SQLite SQL。成就只由 I26B 消费已结算事实事件，不能在本模块直接写入。
