# Pricing Application

实现外部价格快照与新鲜度的命令、查询与事务编排。I13B 的 `PriceSyncService` 先验证 MTGJSON 输入，再以短事务追加运行、UUID/工艺映射和 SKU 状态快照；失败只追加失败记录并保留最近成功指针。任务执行时通过注入的结构化日志记录失败批次、任务 attempt、校验文件和预期/实际 SHA-256，不记录外部 URL 或原始响应；本层仍不依赖 Fastify 细节。
