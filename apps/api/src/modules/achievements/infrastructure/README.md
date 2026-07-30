# Achievements Infrastructure

实现成就所需的 SQLite 查询与外部适配器（如需）。实现必须遵从 domain/application 的接口；
跨模块数据（库存、账本、赛事）只经对方 application 接口访问，不能直接操作其表。
