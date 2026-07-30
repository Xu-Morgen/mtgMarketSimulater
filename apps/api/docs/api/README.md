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
- `GET /v1/inventory/{skuId}` 返回当前玩家该 SKU 的持有量、可用量、订单/比赛锁定量、移动平均成本、服务端 `marketUnitPrice`、全部持有的 `marketValue`、`unrealizedProfitLoss` 和本地展示卡牌资料；目录资料包含本地快照的费用符号、卡面颜色、颜色标识、类别行、规则文本及攻防（缺失时显式为 null/空），供卡组编辑器展示和筛选。三项估值字段均在 SQLite 查询中以整数产生，浏览器不得相乘、相减或用可用库存替代全部持有量。未持有返回 `404 RESOURCE_NOT_FOUND`。`marketValue: null` 时响应带 `marketValueUnavailableReason`，客户端不得自行估算市值。
- `GET /v1/inventory/{skuId}/reconciliation` 返回服务端校验的数量恒等式和不可变 `inventory_entries` 分页流水，供排障与未来管理查询反查。上述路由均不提供改库存或解锁功能；锁定、释放、扣减仅能由开包、订单和比赛的服务端命令完成。

## I13B MTGJSON 价格同步协议

- `GET /v1/admin/prices/sync` 仅管理员可读，返回 `PriceSyncStatusDto` 的最近成功/当前运行、两份输入的 SHA-256、校验状态、稳定失败码、映射/有价/无价/映射失败统计、时间与脱敏失败摘要，以及 `checksumBypassAvailable`；不返回外部下载地址或原始数据。
- `POST /v1/admin/prices/sync` 仅管理员可投递 `prices.sync`，要求至少 8 位 `Idempotency-Key`。可选请求体为 `{ expectedPricesChecksumSha256?, expectedMappingChecksumSha256?, allowChecksumMismatch?: true }`。`allowChecksumMismatch` 仅在最近一次运行的稳定失败码为 `CHECKSUM_MISMATCH` 时接受，否则返回 `409 RESOURCE_CONFLICT`；成功投递写入 `price_sync.checksum_bypass_requested` 审计事实，并把成功快照标为 `bypassed`。同一键返回同一个持久化任务。缺键或格式错误返回 `400 IDEMPOTENCY_KEY_REQUIRED`/`VALIDATION_FAILED`，角色不足返回 `403 AUTHORIZATION_DENIED`。

## I13F 公开价格状态协议

- `GET /v1/prices/status` 要求有效会话，返回 `PublicPriceStatusDto` 的公开来源、最近成功同步更新时间与服务端判定的 `fresh`、`stale` 或 `unavailable` 状态。最近一次同步失败但有成功快照时为 `stale`；没有成功快照时为 `unavailable`。
- 此端点绝不返回版本、校验和、映射统计、任务、失败摘要、下载地址或 Provider 原始内容；这些管理详情继续只由 `/v1/admin/prices/sync` 返回并要求 admin。

## I14B 市场报价协议

- `GET /v1/market/quotes/{skuId}` 要求有效 Bearer 会话，仅读取已持久化的 `QuoteDto`：Cardmarket EUR 欧分锚点、游戏内中间价、NPC 买入/卖出价、规则版本、快照/计算时间。它不接受浏览器提供的兑换率、系数、价差或费用；没有来自有效外部快照的报价时返回 `404 PRICE_UNAVAILABLE`。
- `GET /v1/market/index` 要求有效会话，返回最新每 SKU 报价投影的外部参考指数、游戏指数、已报价 SKU 数和最近计算时间。指数为展示用聚合，客户端不得根据它或单卡报价推导交易结算。
- `market.reprice` 由成功 `prices.sync` 的运行 ID 或已结算经济事实 ID 唯一投递。每次报价保留规则版本、参数快照和原因摘要；重放相同触发键不会重复叠加事件或生成第二份报价。同步或重定价失败时保留最近成功报价，SKU 的新交易资格仍以价格快照的 `tradable` 状态为准。

## I14F 市场首页只读查询协议

- `GET /v1/market/quotes?query=&setCode=&rarity=&finish=&tradable=&cursor=&limit=` 要求有效会话，服务器按目录字段筛选并返回精确总数的 `Page<MarketQuoteListItemDto>`。每项含最小 SKU 资料、最新持久化 `QuoteDto`（外部锚点、游戏内/NPC 报价、计算时间和受界原因）及服务端判定的 `tradable`/`tradeDisabledReason`；不返回可由浏览器重算的市场参数、费用或原始 Provider 数据。
- `tradable=untradable` 用于查阅无有效参考价 SKU；其 `quote` 可以为 `null`，页面必须禁用交易入口并显示服务端原因。全局来源、新鲜度和最后成功同步时间仍仅由 `GET /v1/prices/status` 返回；任何查询失败均不得被客户端包装成实时或可交易数据。

## I15B NPC 买入协议

- `GET /v1/npc-trades/buy/{skuId}/preview?quantity=` 要求有效玩家会话，返回 `NpcBuyPreviewDto`：不可变 `quoteId`、`quoteVersion`、服务端 `unitPrice`/内含 `unitFee`、总价、总费用、有效期和服务端单笔/单日额度。`market/v1` 报价从服务端计算时间起有效 15 分钟；浏览器只可展示结果，不得自行计算金额、费用或额度。没有可交易报价返回 `404 PRICE_UNAVAILABLE`，报价已过期返回 `409 VERSION_STALE`。
- `POST /v1/npc-trades/buy/{skuId}` 要求有效玩家会话及格式正确的 `Idempotency-Key`。请求体严格为 `{ quoteId, quoteVersion, quantity, maxUnitPrice }`；`maxUnitPrice` 是玩家确认的上限，不是服务端定价输入。服务端只从 `quoteId` 指向的持久化 `market_quotes` 读取成交价和费用，并校验 SKU 可交易、规则版本、有效期、限价、余额、单笔额度与当日已成交量。
- 成功以 `201` 返回成交、服务端余额与持仓；同键同参重放以 `200` 返回首次完整响应，同键异参返回 `409 IDEMPOTENCY_CONFLICT`。无报价、报价/限价过期、余额不足和交易量限制分别使用 `PRICE_UNAVAILABLE`、`VERSION_STALE`、`INSUFFICIENT_BALANCE`、`RULE_VIOLATION`；失败同样完成幂等记录，但任何未处理写入异常会回滚经济变更及幂等占位。

## I16B NPC 卖出协议

- `GET /v1/npc-trades/sell/{skuId}/preview?quantity=<正整数|all>` 要求有效玩家会话，返回 `NpcSellPreviewDto`：不可变 `quoteId`、`quoteVersion`、服务端 NPC 收购 `unitPrice`/内含 `unitFee`、收入、可用库存、有效期与额度。`all` 只由服务端解析为当前可用数量；没有可用库存时预览明确返回 `canSell: false` 和 `insufficient_inventory`，不会出售订单或比赛锁定量。
- `POST /v1/npc-trades/sell/{skuId}` 要求有效玩家会话、格式正确的 `Idempotency-Key`，且请求体严格为 `{ quoteId, quoteVersion, quantity, minUnitPrice }`。`minUnitPrice` 是玩家确认的保护下限，服务端只读取 `quoteId` 指向的持久化 NPC 收购价和费用，并校验可交易、版本、有效期、最低价、可用库存及单笔/当日额度。
- 成功以 `201` 返回成交、服务端余额与持仓；同键同参重放为 `200`，同键异参为 `409 IDEMPOTENCY_CONFLICT`。无报价、报价/最低价过期、可用库存不足与交易量限制分别使用 `PRICE_UNAVAILABLE`、`VERSION_STALE`、`INSUFFICIENT_INVENTORY`、`RULE_VIOLATION`；成交在一笔短事务同时追加 `npc_sell` credit 账本、库存流水、成交、事实/outbox、重定价任务与审计，未处理异常回滚经济写入和幂等占位。

## I24B Commander 草稿与合法性协议

- `GET /v1/decks`、`GET /v1/decks/{deckId}` 仅返回当前玩家草稿、固定 `commander-100/v1` 规则/禁牌表版本、服务端合法性结果和 `strengthSnapshot: null`。草稿阶段不评分、不报名、不收费、不建立 `inventory_holds`；已保存响应只含卡组可读摘要，不含 Provider 完整响应或密钥材料。
- `POST /v1/decks/validate` 接收 `{ name, banlistVersion?, cards[] }` 并只返回服务端合法性和可用库存提示，不写状态。`cards` 只允许本地 `skuId` 的 `commander|main|companion` 项，或固定 `virtual_basic`（`plains|island|swamp|mountain|forest`）；虚拟基本地没有 SKU、库存、持仓、市场或锁定记录。
- `POST /v1/decks` 与 `PUT /v1/decks/{deckId}` 使用同一请求体并要求 `Idempotency-Key`。合法性不足、库存不足或禁牌不妨碍保存草稿，但结果明确 `legality.valid=false` 和问题列表；同键同参返回首次完整结果，同键异参返回 `409 IDEMPOTENCY_CONFLICT`。保存/编辑不会替浏览器或 Provider 判定最终报名资格，I25B 报名时仍须重新读取已保存卡表、可用库存与版本快照。
- `commander-100/v1` 只接受单指挥官 `1+99` 或官方允许双指挥官 `2+98`，以 Oracle 身份判定单例，检查颜色标识、当前持久化官方禁牌表、Companion 限制和虚拟基本地颜色。禁牌表版本是草稿事实的一部分；新版本只影响显式采用它的后续构筑，旧草稿/未来报名快照不会被后台覆写。
- Leyline 端点、超时和重试只由服务端 `LEYLINE_*` 配置控制。默认 Provider 为 `POST https://api.mtgleyline.com/api/deck-ranking/analyze`，请求体为 `{ format: "commander", decklistText }`；`leyline-adapter/v2` 接受 `scores.power`（0–100）及 Provider 在无缺失卡时返回的 `missingCards: null`，并在领域快照中归一化为空数组。依 ADR-003，草稿端点绝不调用 Provider；I25B 只能在报名事务的收费/锁卡/创建报名之前调用，失败时不得改写任何历史快照或资产。
- 卡组编辑器对库存卡使用服务端投影的表格展示费用/颜色、类别、规则文本、攻防和本地图片预览；前端的名称、费用颜色、类别与指挥官颜色筛选只影响展示，不能判定颜色合法性或可用库存。库存表中只有 `typeLine` 为传奇生物的本地 SKU 开放“设为指挥官”入口；保存或报名仍须经服务端完整复核。`0027_card_display_fields.sql` 部署后必须重启 API 以应用迁移，再由管理员投递一次受控 `catalog.sync` 回填既有目录的费用、颜色和攻防快照。

## I18B P2P 双边委托预览与创建协议

- `GET /v1/orders/buy|sell/{skuId}/preview?quantity=` 要求有效玩家会话，返回 `BilateralOrderPreviewDto`：以当前 `market_quotes.market_price` 为锚点的限价带 `limitBand{min,max}`、服务端 `fees[order_fee, fulfillment_deposit]`、`reservedFunds`、`estimatedAmount`、可用资金/库存、`previewVersion` 与有效期。没有可交易报价返回 `404 PRICE_UNAVAILABLE`，报价过期返回 `409 VERSION_STALE`。
- `POST /v1/orders/buy|sell/{skuId}` 要求有效玩家会话及格式正确的 `Idempotency-Key`；请求体严格为 `{ quoteId, quoteVersion, previewVersion, quantity, limitPrice }`。服务端校验预览版本未过期、报价/快照 ID 与版本一致、限价落在带内、单笔/单日额度、余额（买单）或可用库存（卖单）。买单原子预占 数量*限价+order_fee；卖单锁定库存并只预占 fulfillment_deposit（order_fee 在 I19B/I20B 履约时扣除）。客户端不得自报费用或保证金。
- 成功以 `201` 返回 `BilateralOrderDto`；同键同参重放为 `200`，同键异参为 `409 IDEMPOTENCY_CONFLICT`。余额不足、库存不足/被锁定、额度超限、限价越界分别使用 `INSUFFICIENT_BALANCE`/`INSUFFICIENT_INVENTORY`/`INVENTORY_LOCKED`/`RULE_VIOLATION`；预览或报价过期使用 `VERSION_STALE`。创建与预占/锁定在同一短事务完成，未处理异常回滚委托、资金/库存预占和幂等占位。
- `GET /v1/orders?status=&side=&cursor=&limit=`、`GET /v1/orders/{orderId}` 只返回当前玩家的委托；`POST /v1/orders/{orderId}/cancel` 以幂等键撤单，释放未成交资金（买单）或库存+保证金（卖单），重复撤单返回 `409 RESOURCE_CONFLICT`。`GET /v1/orders/book/{skuId}` 返回只读订单簿（买单按价格降序、卖单按价格升序聚合），不含用户身份。
- I18F 前端消费：`apps/web/api/orders-api.ts` 是上述 8 个端点的唯一入口，请求体与错误语义严格遵循本协议；浏览器只回传 `{quoteId,quoteVersion,previewVersion,quantity,limitPrice}` 与玩家确认的限价，绝不回传或本地重算费用、保证金、限价带或预计金额。

## I19B P2P 撮合协议

- 撮合触发：`POST /v1/orders/buy|sell/{skuId}` 创建成功后会自动触发一次 `OrderService.match(skuId)`；撮合在独立短事务执行，失败只记日志、不影响委托创建结果。`POST /v1/orders/{skuId}/match`（admin 角色）供运维/测试显式重跑撮合，返回 `MatchResultDto{skuId, trades[], capturedAt}`，普通玩家返回 `403 AUTHORIZATION_DENIED`。
- 撮合顺序与成交价完全由 `packages/rules` 的 `order-matching/v1` 决定：买单按限价降序、卖单按限价升序，同价按 rowid（sequence）时间优先；当买限价 >= 卖限价时成交 `min(买余量, 卖余量)`，成交价取 maker（先入订单簿一方）限价，createdAt 相同按 sequence 决定 maker。同用户买卖自成交跳过不撮合。
- 成交落库与待履约持有：每条成交写一行 `bilateral_trades`（status=`matched_pending_fulfillment`），买方已成交资金（数量*限价+已成交 order_fee）从 `order_buy` 预占转 `order_fulfillment` 待履约 hold，卖方已成交库存部分捕获离开持有（`inventory_holds` 收缩到剩余），卖方保证金按已成交/剩余切分；剩余委托保持 `partially_filled`，全成交则双方推进为 `matched_pending_fulfillment`。本期不转移最终所有权、不写 `p2p.trade.settled`、不结算卖方收入/保证金（留 I20B）。
- 并发与幂等：撮合在 `InventoryService.withLedgerTransaction` 短事务内串行执行，逐 leg 以条件 UPDATE（`WHERE version=? AND remaining_quantity>=?`）扣减双方剩余；`bilateral_trades UNIQUE(buy_order_id, sell_order_id, execution_price_amount)` 保证同一对委托在相同成交价下至多一行成交。并发撮合不会超卖、超扣或重复成交；任一 leg 写入异常整笔回滚，不留半完成成交、状态或 hold。

## I19F P2P 撮合状态玩家只读视图协议

- `GET /v1/orders/trades?skuId=&cursor=&limit=`（player 角色）分页返回当前玩家作为买方或卖方的成交 `PlayerBilateralTradeDto{skuId, role, myOrderId, quantity, executionPrice, fee, pendingFunds, pendingInventoryQuantity, ruleVersion, status, createdAt, updatedAt}`。纯读、无写、无幂等键、无审计；浏览器不得推导或缓存为真相，连接失败时提示数据可能过期。
- 脱敏对手身份：响应只含当前玩家自己的 `myOrderId`、`role`（buyer/seller）与已转入待履约的资产；对手 userId、对手 orderId 与所有 holdId 一律不返回。买方 `pendingFunds = 数量×成交价+order_fee`、`pendingInventoryQuantity = null`；卖方 `pendingFunds = 已成交保证金`（卖单单位保证金×数量）、`pendingInventoryQuantity = 已离开持有的成交数量`。
- 撮合顺序、成交价与部分成交语义仍由 `order-matching/v1` 决定；订单簿 `GET /v1/orders/book/{skuId}` 只读聚合、不含用户身份。玩家页面只展示服务端状态。

## I20B 模拟履约、取消与到期协议

- `POST /v1/orders/trades/{tradeId}/fulfill`（player，请求体为空，需 `Idempotency-Key`，买卖任一方均可发起）确认模拟履约：服务端在单短事务内按成交价结算买方扣款（先释放撮合时按买单限价预占的全量 `order_fulfillment` hold，再按 数量×成交价+order_fee 扣款，限价与成交价的差额退回买方 available）、把库存以成交价为成本转入买方、`releaseOrderFunds` 返还卖方保证金、`creditAvailableFunds` 卖方收入（数量×成交价-order_fee），成交推进为 `fulfilled`，并追加 `p2p.trade.settled` 事实事件 + outbox + `market.reprice` 任务；响应 `{trade: BilateralTradeDto, balance}`，`balance` 取请求者视角。已 `fulfilled`/`cancelled` 的成交返回 `409 RESOURCE_CONFLICT`；无关玩家对他人成交返回 `404 RESOURCE_NOT_FOUND`（不泄露存在性）。
- `POST /v1/orders/trades/{tradeId}/cancel`（player，同上）取消模拟履约：退回买方全量待履约资金、`captureFunds` 扣除卖方已冻结保证金、`restorePartial` 恢复卖方库存（已成交数量加回 quantity/available），成交推进为 `cancelled`，**不产生 `p2p.trade.settled`**；写买卖各一条 `bilateral_trade.cancelled` 审计。
- 到期回收：创建委托与撮合成交时分别投递 `runAfter=expires_at`/`fulfillment_deadline`、`uniqueKey=order-expire:{id}`/`trade-expire:{id}` 的 `order.expire` 任务（`(type, unique_key)` 唯一索引去重）。`order.expire` handler（`OrderService.expireByPayload({kind,id})`）到期把 `open/partially_filled` 委托转 `expired`（释放剩余预占）或 `matched_pending_fulfillment` 成交转取消履约；`POST /v1/orders/trades/{tradeId}/expire`（admin）供运维/测试显式触发成交到期回收，普通玩家 `403`。状态机条件 UPDATE 保证已终态实体不重复迁移。
- 履约期限沿用 `bilateral_order_limits.ttl_seconds`，由 `@mtg-market/rules` 的 `order-fulfillment/v1`（`resolveFulfillmentDeadline`）从撮合时刻派生，写入 `bilateral_trades.fulfillment_deadline`，并随 `BilateralTradeDto`/`PlayerBilateralTradeDto.fulfillmentDeadline` 返回。并发与幂等由 SQLite 短事务串行 + 条件 UPDATE 保证至多一次业务结果；同键同参重放返回首次响应，异参 `IDEMPOTENCY_CONFLICT`。本期单一模拟履约类型，不引入实体物流状态。

## I21B 订单风控协议

- `POST /v1/orders/buy|sell/{skuId}` 在既有基础资产校验后、预占前执行 `order-risk/v1`；异常价格、冷却、窗口频率、数量限额与潜在自买自卖返回 `409 RULE_VIOLATION`，同键重放仍遵循既有幂等协议。
- 高频撤单完成原子释放后追加 `flagged` 决策。`GET /v1/admin/orders/risk-decisions?outcome=blocked|flagged&cursor=&limit=`（admin）仅返回脱敏 `OrderRiskDecisionDto`，不提供放行或写资产命令。

## I23B 每日工作资金协议

- `GET /v1/daily-work-funding`（player）返回 `DailyWorkFundingStatusDto`：服务端 `naturalDate`、`timezone`、资格状态、已快照的规则/金额、领取记录和 `nextEligibleAt`。状态仅为 `available`、`claimed`、`not_open` 或 `archive_required`；浏览器不得以本地日期自行判断。
- `POST /v1/daily-work-funding/claim`（player）请求体必须是 `{}`，要求格式正确的 `Idempotency-Key`。当日已由 `daily.rollover` 开放且已建档时，返回 `201 { funding }`；同键同参返回首次 `200`，同键异参为 `409 IDEMPOTENCY_CONFLICT`，未开放/未建档/同日换键重复领取为 `409 RESOURCE_CONFLICT`。成功结果包含金额、自然日、时区、规则版本和领取时间。
- `daily.rollover` 的 job payload 是服务端内部协议，不暴露给浏览器；它固定日期、IANA 时区和工作资金规则版本，仅创建资格快照，不直接给任何用户入账。

## I17B 价格历史、每日同步与 AllPrices 回填协议

- `GET /v1/market/quotes/{skuId}/history?range=7d|30d|all` 与 `GET /v1/market/index/history?range=7d|30d|all` 要求有效会话，按自然日采样返回 `PriceHistoryDto`/`MarketIndexHistoryDto`。历史来自只追加的 `price_snapshot_entries`（reference）与 `market_quotes`（game），同日多次同步/重定价取该日最新值；任一价格缺失为 null，空历史返回空 `points` 数组而非 `404`，确保失败同步仍能展示旧价或空态。浏览器不得自行计算曲线或推断缺失值。
- 每日同步由 task runner 内嵌日切轮询以 UTC 自然日唯一键（`prices.sync:daily:<date>` + `price_sync_schedule_state`）调度；停机多日只补投一次，同日重放不重复投递。成功后仍以快照运行 ID 投递 `market.reprice`；失败保留最近成功快照并告警。`daily.rollover` 的发钱/赛事刷新延后至 I23B/I25B。
- `GET /v1/admin/prices/backfill` 仅管理员可读，返回 `PriceSyncBackfillResultDto`：最近一次 `prices.backfill` 监督运行的来源版本、SHA-256、校验状态、日期范围、插入/跳过统计、失败摘要与 `currentJob`。
- `POST /v1/admin/prices/backfill` 仅管理员可投递，要求至少 8 位 `Idempotency-Key`。可选请求体为 `{ expectedPricesChecksumSha256?, allowChecksumMismatch?: true }`；同一键返回同一个任务。回填下载独立 `AllPrices` 端点，按每 SKU 最新成功映射只追加缺失的历史日期快照（`run_kind='backfill'`）；绝不覆盖已有每日同步快照、移动 `price_sync_state`/`price_sync_schedule_state` 指针或为历史日投递 `market.reprice`。
- `PriceSyncRunDto.runKind` 区分 `daily`（日常 AllPricesToday 同步）与 `backfill`（一次性 AllPrices 历史回填）；`PublicPriceStatusDto.disclaimer` 由服务端固定为“外部参考价来自 MTGJSON / Cardmarket EUR 快照，游戏内价为虚拟货币 GAME_CREDIT；均为非实时、非真实资产”，不暴露版本/checksum/任务。

## I11B 补充包概率公示协议

- `GET /v1/packs` 与 `GET /v1/packs/{packId}` 要求有效 Bearer 会话，返回 `PackDto` 列表或单个配置。每项包含整数最小货币单位价格、启用状态/停用原因、规则版本和卡位稀有度概率；每个卡位的 `probabilityBasisPoints` 总和固定为 10,000，数值由服务端版本化规则计算。
- 响应不包含候选 SKU 池、随机种子、随机结果或保底进度；MVP 没有保底状态。未知补充包返回 `404 RESOURCE_NOT_FOUND`，非法 UUID 返回 `400 VALIDATION_FAILED`，未认证返回 `401 AUTHENTICATION_INVALID`。
- 概率公示与商店结算分离；开包写命令见 I12B，客户端不得以公示概率自行抽样或推导产出。

## I12B 商店购买与服务端开包协议

- `GET /v1/store/packs` 仅返回当前启用、可结算的补充包；`GET /v1/store/packs/{packId}/purchase-preview` 返回服务端价格、当前 `ruleVersion`、余额是否足够与不可购买原因。未知包返回 `404 RESOURCE_NOT_FOUND`，下架包预览返回 `409 RESOURCE_CONFLICT`。
- `POST /v1/packs/{packId}/open` 要求有效 Bearer 会话、格式正确的 `Idempotency-Key` 和 `{ ruleVersion }`。规则版本变化返回 `409 VERSION_STALE`；下架包、未建档、余额不足或包含失效 SKU 的规则包不会扣款，分别使用 `RESOURCE_CONFLICT`、`INSUFFICIENT_BALANCE` 或 `RULE_VIOLATION`。同键同体成功重放返回已持久化的开包结果（HTTP `200`），不同请求体返回 `409 IDEMPOTENCY_CONFLICT`。
- 成功结算（`201`）在一个 SQLite 短事务中追加 `pack_rule_replays`、`pack_openings`、`pack_purchase` debit 账本、`pack_opened` 库存流水、`pack.opened` 事实事件/outbox 及审计记录；任一失败会回滚全部写入。`GET /v1/pack-openings?cursor=&limit=` 仅分页返回当前玩家的结果。
- `PackOpeningDto` 仅包含 SKU、分摊成本和已结算时间；不返回候选池或随机种子。I17B 前每项和盈亏摘要均以 `priceStatus: "unavailable_until_i17"`、参考价/游戏内价/盈亏为 `null` 明确表示价格尚不可用，不提前生成报价。

## I25B 比赛、报名与确定性结算协议

- `GET /v1/tournaments` 只返回当前认证玩家、按 `APP_TIMEZONE` 自然日隔离的个人 NPC 赛事。受控模板冻结座位、报名条件、费用、难度、每日次数、开赛方式、开放/截止时间、规则版本和奖励池；`daily.rollover` 与延迟访问都以 `(template_id,natural_date,owner_user_id)` 唯一键补建，绝不重置已有赛事。`GET /v1/tournaments/history` 只返回当前玩家已报名赛事及已有的服务端结算结果；`GET /v1/tournaments/{tournamentId}/registration`、`/result` 只允许读取自己的快照和 NPC 公开重放材料。
- `POST /v1/tournaments/{tournamentId}/register` 接收 `{ deckId }` 与格式正确的 `Idempotency-Key`。先重新验证已保存 Commander 卡表、禁牌版本、Companion 和可用库存，再调用 Leyline；只有 Provider 成功后才在一个短事务追加加密源记录、评分/完整卡表快照、报名、所有非虚拟基本地（含 Companion）hold、报名费、审计和唯一 `tournament.settle` 任务。评分失败、卡组变化或库存冲突不会收费、锁卡或创建报名。
- Leyline 评分不可用返回 `503 SCORING_UNAVAILABLE`；`error.details` 仅包含受控的 `provider: "leyline"`、`failureReason`（`timeout`、`network`、`http_status`、`invalid_json`、`invalid_schema` 或 `unknown`）、`attempts` 和可选 `httpStatus`。服务端以 `tournament.registration_scoring_failed` 记录同一分类与请求 ID；绝不返回或记录卡表、Provider 端点、原始响应或底层错误文本。真实卡组/禁牌版本变更仍返回 `409 VERSION_STALE`。
- 单场、瑞士与预报名赛事由 `tournament/v1` 只消费报名评分快照和持久化 seed 结算。瑞士固定 4/1/0/1/0、公布人数轮次和晋级线；NPC 填满空座、不会领取奖励，只有冠军奖励位同分才进行 seed 驱动的加赛。结算在一个短事务释放 hold（不 capture 卡牌）、写结果/奖励/随机池候选与命中项、`tournament.settled` 和审计；重复领取任务或重放报名不会再次收费、解锁或奖励。
- 奖励池可原子授予 `GAME_CREDIT`、本地 SKU 或当时在售补充包。NPC 奖励使用 `GET /v1/tournament-pack-grants` 与 `POST /v1/tournament-pack-grants/{grantId}/claim`；玩家赛事奖励使用对应的 `/v1/player-tournament-pack-grants` 路径。两类领取均以幂等键一次性消费凭证，并把入库、开包事实、审计与凭证状态放在同一事务。
- 玩家赛事：`POST /v1/player-tournaments` 创建受控 Commander 游戏内或现实桌赛事，并绑定服务器发布的奖励配置（编辑能力留给 I30B）；`GET /v1/player-tournaments` 只列出当前创建者或报名者可读取的赛事，`GET /v1/player-tournaments/{id}`、`/registrations`、`/rounds`、`/result` 只对创建者或报名者可读。游戏内报名提交 `{ deckId }` 并按上述服务端快照/hold 规则执行，`POST /start` 投递唯一结算任务；现实桌报名只接受 `{ deckName }`，不保存或锁定实体卡组。现实桌配对、结果提交、全桌确认、退出、争议和最终结算分别走 `/rounds`、`/result`、`/confirm`、`/withdraw`、`/disputes`、`/settle`，所有写请求都需幂等键。
- 现实桌的服务端规则为目标每桌 4–8 人（人数不足时不拒绝赛事）、胜 4、平局全桌 1、弃权/退出 0；未获同桌全体确认前不记分。只有跨越不同奖励配置的同分名次会生成 `stage=playoff` 的额外同桌，且仍须全桌确认至分出名次。争议只可由 `POST /v1/admin/tournament-disputes/{disputeId}/resolve`（admin、理由、赋分、幂等键）结案。非 NPC seed、完整配对和重放不向玩家返回，仅 `GET /v1/admin/player-tournaments/{tournamentId}/replay` 可读。

## I26B 成就查询协议

- `GET /v1/achievements`、`GET /v1/achievements/unlocks` 和 `GET /v1/achievements/detail?definitionId=<id>` 都要求 player 会话，且只读当前玩家的数据。定义 ID 可包含 `/v1` 后缀，因此详情使用查询参数而非路径参数；未知 ID 返回 `404 RESOURCE_NOT_FOUND`。
- 概览返回受控定义及服务端进度；解锁返回不可变来源（`tournament.settled` fact 与报名 aggregate）、规则版本、奖励明细、关联 correlation ID 和 `rewardStatus`。`granted` 表示奖励已经在服务端事务中发放，`blocked` 表示成就已经解锁但奖励被每日风控拦截；两个状态都不是浏览器可变更的资源。
