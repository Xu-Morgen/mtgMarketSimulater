# Tournaments Infrastructure

实现 赛事、赛果、奖励和成就 所需的仓储、SQLite 查询、外部适配器与文件访问。实现必须遵从 domain/application 的接口；跨模块数据只经对方 application 接口访问，不能直接操作其表.

