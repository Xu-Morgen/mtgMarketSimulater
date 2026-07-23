# 测试目录

测试按目标分层存放：纯规则放 `unit`，SQLite/仓储和事务放 `integration`，HTTP 合约放 `contract`，端到端主流程放 `e2e`。测试不得依赖生产 `data/` 文件。
