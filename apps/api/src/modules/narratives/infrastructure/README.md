# Narratives Infrastructure

I33 发布后启用 I34 时，实现 AI 与模板战报所需的仓储、SQLite 查询、外部适配器与文件访问。首发不实例化或调用这些适配器。实现必须遵从 domain/application 的接口；跨模块数据只经对方 application 接口访问，不能直接操作其表。
