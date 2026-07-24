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

## I06B 认证与会话协议

- `POST /v1/auth/register` 和 `POST /v1/auth/login` 接收 email、password（最少 12 位）及注册所需的 displayName，返回短期 Bearer access token 与最小用户信息；密码或账户不存在统一返回 `401 AUTHENTICATION_INVALID`，避免枚举账户。
- `POST /v1/auth/refresh` 与 `POST /v1/auth/logout` 从 `mtg_refresh` HttpOnly Cookie 读取 refresh token，并强制校验同路径 `mtg_csrf` Cookie 对应的 `X-CSRF-Token`。成功刷新会立即撤销旧 token 并写入新会话；旧 token 重放返回 `401` 且撤销该轮换链。登出会撤销会话并清除两种 Cookie。
- `GET /v1/auth/session` 和受保护端点须传 `Authorization: Bearer <access token>`。无效、过期或已撤销会话返回 `401 AUTHENTICATION_INVALID`；角色不足返回 `403 AUTHORIZATION_DENIED`。`/v1/admin/*` 全部要求 admin。
- Cookie 固定 `Path=/v1/auth`、`HttpOnly`（仅 refresh）、`SameSite=Strict`；生产环境包含 `Secure`。认证端点按来源 IP 进行基础每分钟滑动窗口限制，超限返回 `429 RATE_LIMITED`。配置必须提供至少 32 字符的 `AUTH_JWT_SECRET`，不得提交真实值。

## I07B 存档与账本协议

- `POST /v1/archive` 要求有效 Bearer 会话、空对象请求体与格式正确的 `Idempotency-Key`。首次调用在单一短事务创建唯一存档、`GAME_CREDIT` 账户和 `initial_funding` credit 流水，返回 `201`；同一键重放返回首次完整响应（`200`），同键不同请求指纹返回 `409 IDEMPOTENCY_CONFLICT`，处理中返回 `409 IDEMPOTENCY_IN_PROGRESS`。
- `GET /v1/archive` 返回存档摘要、总额/可用额/冻结额及 `netWorth: null` 占位；`GET /v1/account` 返回余额；`GET /v1/ledger?cursor=&limit=` 仅返回当前用户的不可变账本流水。未建档时前两者返回 `404 RESOURCE_NOT_FOUND`，空账本列表保持 `200`。
- 金额始终为 `GAME_CREDIT` 的整数最小单位。账户不提供直接修改路由；未来买单、保证金等资金操作必须调用 users application 的冻结、释放或扣除原语，并将业务实体与 `fund_holds` 关联。

## I05 管理任务协议

- `GET /v1/admin/jobs?status=&limit=` 返回任务状态与最近错误摘要；`POST /v1/admin/jobs` 以 `(type, uniqueKey)` 去重投递预注册任务；`POST /v1/admin/jobs/{id}/retry` 将 `failed`/`dead` 任务重新置为 pending。
- 两个写端点都要求至少 8 位 `Idempotency-Key`，缺失时返回 `400 IDEMPOTENCY_KEY_REQUIRED`。I06B 完成前这些接口尚未具备用户级授权，只限受控运维网络调用；认证上线时必须收紧为 admin。
