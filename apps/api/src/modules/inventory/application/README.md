# Inventory Application

实现库存、锁定与持仓的命令、查询与事务编排用例。`InventoryService.withLedgerTransaction` 是开包、订单和比赛写入库存、账本、事实事件的共同短事务边界；不依赖 Fastify 细节，也不暴露具体 SQLite SQL。
