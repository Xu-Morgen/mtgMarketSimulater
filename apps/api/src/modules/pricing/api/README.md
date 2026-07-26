# Pricing API

处理外部价格快照与新鲜度的 Fastify 路由、鉴权、输入验证、幂等键读取和 HTTP 响应映射。I13B 提供仅管理员可用的 `/v1/admin/prices/sync` 状态和任务投递；不得直接调用 Provider 或包含结算规则。
