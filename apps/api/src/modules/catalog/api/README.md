# Catalog API

处理卡牌目录、印刷版本和 SKU 的 Fastify 路由、OpenAPI Schema、请求鉴权、输入验证和 HTTP 响应映射。I08B 提供认证后的只读目录/详情查询；不得编写 SQL、直接调用外部服务或包含结算规则，只调用本模块 application 用例。
