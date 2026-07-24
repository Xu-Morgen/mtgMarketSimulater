# API Conventions

记录版本化、资源命名、分页、错误码、幂等键、认证和 OpenAPI 发布规范。具体 endpoint 的 Schema 属于对应模块的 `api` 层。

## I02 共享协议

- 唯一共享来源为 `@mtg-market/contracts`；HTTP 成功响应为 `{ ok: true, data, meta: { requestId } }`，失败响应为 `{ ok: false, error: { code, message, details? }, meta: { requestId } }`。
- 分页读取使用 `PageRequest` 的可选 `cursor`、`limit`，返回 `Page<T>` 和 `nextCursor`；金额为 `Money.amount` 的整数最小单位，时间为 UTC ISO 8601。
- 所有变更请求必须带 `Idempotency-Key`，并由 API 对规范化请求体生成 SHA-256 `requestFingerprint`。同一调用者、同一键、同一指纹返回首次完成的完整响应；同键不同指纹返回 `409 IDEMPOTENCY_CONFLICT`；尚在执行的同键请求可返回 `409 IDEMPOTENCY_IN_PROGRESS`。并发调用由持久化唯一约束保证只产生一个业务结果。
- 标准错误码定义于 `ApiErrorCode`，其中鉴权、参数、余额不足、库存不足/锁定、报价不可用、版本过期与幂等冲突分别使用专用代码，客户端不得从文案推断错误类型。
- `pack.opened`、`npc.trade.settled`、`p2p.trade.settled`、`tournament.settled` 均为 `version: 1` 的已结算事实事件。消费者只能基于其记录历史/聚合，不能把事件解释为待执行命令。

## I04 HTTP 与可观测性协议

- 每个 API 响应（包括 404、输入校验和内部异常）都使用上述包络，并在 `meta.requestId` 和响应头 `X-Request-Id` 返回关联标识。客户端可提交符合 contracts 格式的 `X-Request-Id`，无效或缺失时服务端生成 UUID。
- `GET /health` 是不依赖业务模块的存活检查；`GET /ready` 返回 SQLite 可查询状态和按状态聚合的持久化任务摘要。依赖失败时 `/ready` 返回 `503 INTERNAL_ERROR` 包络。
- 浏览器 CORS 来源只可由 `CORS_ORIGINS` 配置；未配置时只允许 `WEB_ORIGIN`。带 Cookie 的跨域请求必须命中白名单。
- 当前 OpenAPI 3.1 文档源为 `src/openapi.ts`，运行时可读取 `GET /openapi.json`；对应集成测试检查 OpenAPI 版本和已公开路由，新增公开路由必须同步更新此文档。
- API Pino 日志会脱敏授权头、Cookie、API key、密码和 token。写路由审计仅保存可信调用者（认证完成前为空）、幂等键、路由实体、状态码和请求 ID，禁止保存原始请求体或凭据。
