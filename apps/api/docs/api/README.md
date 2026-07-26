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
- Cookie 固定 `Path=/v1/auth`、`HttpOnly`（仅 refresh）、`SameSite=Strict`；生产环境包含 `Secure`。认证端点按来源 IP 进行基础每分钟 100 次滑动窗口限制，超限返回 `429 RATE_LIMITED`。配置必须提供至少 32 字符的 `AUTH_JWT_SECRET`，不得提交真实值。

## I07B 存档与账本协议

- `POST /v1/archive` 要求有效 Bearer 会话、空对象请求体与格式正确的 `Idempotency-Key`。首次调用在单一短事务创建唯一存档、`GAME_CREDIT` 账户和 `initial_funding` credit 流水，返回 `201`；同一键重放返回首次完整响应（`200`），同键不同请求指纹返回 `409 IDEMPOTENCY_CONFLICT`，处理中返回 `409 IDEMPOTENCY_IN_PROGRESS`。
- `GET /v1/archive` 返回存档摘要、总额/可用额/冻结额及 `netWorth: null` 占位；`GET /v1/account` 返回余额；`GET /v1/ledger?cursor=&limit=` 仅返回当前用户的不可变账本流水。未建档时前两者返回 `404 RESOURCE_NOT_FOUND`，空账本列表保持 `200`。
- 金额始终为 `GAME_CREDIT` 的整数最小单位。账户不提供直接修改路由；未来买单、保证金等资金操作必须调用 users application 的冻结、释放或扣除原语，并将业务实体与 `fund_holds` 关联。

## I08B 卡牌目录协议

- `GET /v1/catalog/cards` 要求有效 Bearer 会话（玩家和管理员均可读取），支持 `query`、`setCode`、`rarity`、`finish`、`cursor`、`limit` 筛选和服务端分页。目录返回的每一项均为一个印刷 SKU，绝不按卡名聚合。
- `GET /v1/catalog/cards/{skuId}` 返回该 SKU 的印刷资料、合法性、来源及图像缓存元数据；不存在时返回 `404 RESOURCE_NOT_FOUND`。筛选参数非法时返回 `400 VALIDATION_FAILED`，未认证时返回 `401 AUTHENTICATION_INVALID`。
- `source` 为 `scryfall` 或 `manual-test`；后者必须同时带 `isManualException: true`，用于测试卡或明确运营例外，绝不能表示 Cardmarket 外部参考价。`finish` 固定为 `nonfoil`、`foil` 或 `etched`，并与 `printingId` 共同唯一。
- 目录 API 仅读取本地 SQLite 与本地图片缓存元数据，不会从浏览器或 API 请求 Scryfall。I09 才能通过受控后台任务写入外部同步资料。

## I05 管理任务协议

- `GET /v1/admin/jobs?status=&limit=` 返回任务状态与最近错误摘要；`POST /v1/admin/jobs` 以 `(type, uniqueKey)` 去重投递预注册任务；`POST /v1/admin/jobs/{id}/retry` 将 `failed`/`dead` 任务重新置为 pending。
- 两个写端点都要求至少 8 位 `Idempotency-Key`，缺失时返回 `400 IDEMPOTENCY_KEY_REQUIRED`。I06B 完成前这些接口尚未具备用户级授权，只限受控运维网络调用；认证上线时必须收紧为 admin。

## I09B/F Scryfall 目录同步协议

- `GET /v1/admin/catalog/sync` 仅管理员可读取，返回 `CatalogSyncStatusDto`：脱敏的 `latestSuccessful`、`current` 运行记录以及最近投递的 `currentJob`（目录同步）和 `currentImageCacheJob`（卡图缓存）。运行记录使用 camelCase，包含版本、SHA-256、启用系列、差异、完成时间与失败摘要；不得包含外部下载地址或 Provider 原始响应。`POST /v1/admin/catalog/sync` 仅管理员可投递 `catalog.sync`；请求必须携带至少 8 位 `Idempotency-Key`，同一键返回同一个任务。
- `POST /v1/admin/catalog/image-cache` 仅管理员可投递独立 `catalog.image-cache`：`{ scope: "single", skuId }` 缓存一张已同步的 Scryfall 印刷卡图，`{ scope: "set", setCode }` 补齐整个本地系列的缺图/失败图。任务只读取本地目录中的受控图片地址，绝不重新下载 Bulk 或替换目录；请求同样要求 `Idempotency-Key`。
- API 进程使用仅服务端配置的 `SCRYFALL_USER_AGENT` 请求 Bulk 元数据、Bulk 文件与卡图；该字段不得作为浏览器参数或响应字段暴露。未使用自定义标识时，Scryfall 可返回 `400 generic_user_agent`。
- `GET /v1/catalog/images/{imageName}` 只读取 `CATALOG_DATA_DIR/images` 中服务端生成的 UUID 文件名，要求有效会话，禁止任意路径与 Scryfall URL。目录页面和所有浏览器 API 均不会请求 Scryfall。

## I10B 库存查询协议

- `GET /v1/inventory` 要求有效 Bearer 会话，仅返回当前玩家的库存总览。支持 `query`、`setCode`、`finish`、`locked=any|locked|available`、`sort=updatedAt|name|quantity|availableQuantity`、`direction`、`cursor`、`limit`，所有筛选、排序和分页均在服务端执行。
- `GET /v1/inventory/{skuId}` 返回当前玩家该 SKU 的持有量、可用量、订单/比赛锁定量、移动平均成本、市值快照和本地展示卡牌资料；未持有返回 `404 RESOURCE_NOT_FOUND`。`marketValue: null` 时响应带 `marketValueUnavailableReason`，客户端不得自行估算市值。
- `GET /v1/inventory/{skuId}/reconciliation` 返回服务端校验的数量恒等式和不可变 `inventory_entries` 分页流水，供排障与未来管理查询反查。上述路由均不提供改库存或解锁功能；锁定、释放、扣减仅能由开包、订单和比赛的服务端命令完成。

## I13B MTGJSON 价格同步协议

- `GET /v1/admin/prices/sync` 仅管理员可读，返回 `PriceSyncStatusDto` 的最近成功/当前运行、两份输入的 SHA-256、版本、映射/有价/无价/映射失败统计、时间与脱敏失败摘要，并只返回最近的 `prices.sync` 任务；不返回外部下载地址或原始数据。
- `POST /v1/admin/prices/sync` 仅管理员可投递 `prices.sync`，要求至少 8 位 `Idempotency-Key`。可选请求体为 `{ expectedPricesChecksumSha256?, expectedMappingChecksumSha256? }`，用于受控发布校验；同一键返回同一个持久化任务。缺键或格式错误返回 `400 IDEMPOTENCY_KEY_REQUIRED`/`VALIDATION_FAILED`，角色不足返回 `403 AUTHORIZATION_DENIED`。

## I11B 补充包概率公示协议

- `GET /v1/packs` 与 `GET /v1/packs/{packId}` 要求有效 Bearer 会话，返回 `PackDto` 列表或单个配置。每项包含整数最小货币单位价格、启用状态/停用原因、规则版本和卡位稀有度概率；每个卡位的 `probabilityBasisPoints` 总和固定为 10,000，数值由服务端版本化规则计算。
- 响应不包含候选 SKU 池、随机种子、随机结果或保底进度；MVP 没有保底状态。未知补充包返回 `404 RESOURCE_NOT_FOUND`，非法 UUID 返回 `400 VALIDATION_FAILED`，未认证返回 `401 AUTHENTICATION_INVALID`。
- 概率公示与商店结算分离；开包写命令见 I12B，客户端不得以公示概率自行抽样或推导产出。

## I12B 商店购买与服务端开包协议

- `GET /v1/store/packs` 仅返回当前启用、可结算的补充包；`GET /v1/store/packs/{packId}/purchase-preview` 返回服务端价格、当前 `ruleVersion`、余额是否足够与不可购买原因。未知包返回 `404 RESOURCE_NOT_FOUND`，下架包预览返回 `409 RESOURCE_CONFLICT`。
- `POST /v1/packs/{packId}/open` 要求有效 Bearer 会话、格式正确的 `Idempotency-Key` 和 `{ ruleVersion }`。规则版本变化返回 `409 VERSION_STALE`；下架包、未建档、余额不足或包含失效 SKU 的规则包不会扣款，分别使用 `RESOURCE_CONFLICT`、`INSUFFICIENT_BALANCE` 或 `RULE_VIOLATION`。同键同体成功重放返回已持久化的开包结果（HTTP `200`），不同请求体返回 `409 IDEMPOTENCY_CONFLICT`。
- 成功结算（`201`）在一个 SQLite 短事务中追加 `pack_rule_replays`、`pack_openings`、`pack_purchase` debit 账本、`pack_opened` 库存流水、`pack.opened` 事实事件/outbox 及审计记录；任一失败会回滚全部写入。`GET /v1/pack-openings?cursor=&limit=` 仅分页返回当前玩家的结果。
- `PackOpeningDto` 仅包含 SKU、分摊成本和已结算时间；不返回候选池或随机种子。I17B 前每项和盈亏摘要均以 `priceStatus: "unavailable_until_i17"`、参考价/游戏内价/盈亏为 `null` 明确表示价格尚不可用，不提前生成报价。
