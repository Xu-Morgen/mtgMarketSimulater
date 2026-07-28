# Operations

记录部署、环境配置、数据卷、备份恢复、任务告警、数据同步和故障处理流程。任何涉及经济数据的修复操作必须保留审计证据。

## I04 健康检查

- 容器存活探针调用 `GET /health`；成功只表示 API 进程及其 SQLite 连接可用。
- 流量就绪探针调用 `GET /ready`；只有 SQLite 查询成功时才返回 200，同时响应中的 `jobs` 提供持久化任务状态摘要。返回 503 时不得向该实例分配新流量，先检查结构化日志中的 `requestId` 与数据库可用性。
- `CORS_ORIGINS` 使用逗号分隔的绝对 URL 白名单。生产环境必须显式设置，且不应包含通配符。

## I05 持久化任务处置

- API 启动后先回收租约已过期的 `running` 任务，再串行领取到期的 `pending`/`failed` 任务。正常关闭会停止领取并等待正在执行的处理器返回；非正常中断由下次启动的租约回收处理。
- `GET /v1/admin/jobs` 查询任务，`POST /v1/admin/jobs` 投递去重任务，`POST /v1/admin/jobs/{id}/retry` 仅重试 `failed` 或 `dead`。两个写接口要求 `Idempotency-Key`；I06B 上线前该管理接口只应在受控的内网运维环境使用，随后必须接入 admin RBAC。
- 排障先查看任务的 `last_error` 与 `job_runs` 按 attempt 的运行历史。不要直接修改 `jobs` 状态；确认外部依赖恢复后使用手动重试。租约频繁过期应先检查处理器超时和进程终止原因。

## I09B Scryfall 目录同步

- 首次导入前必须显式设置 `CATALOG_ENABLED_SET_CODES`（英文逗号分隔、系列代码大写）和持久化的 `CATALOG_DATA_DIR`；空系列配置会令任务失败而不会导入完整 Bulk Data。`SCRYFALL_BULK_ENDPOINT` 默认指向 Scryfall `default-cards` 元数据端点，`SCRYFALL_USER_AGENT` 必须标识本服务（建议带运维联系邮箱），两者只允许由 API 进程后台任务访问。Scryfall 会拒绝 Node 默认 User-Agent 并返回 `400 generic_user_agent`。
- `BRO-BASE` 与 `SOS-BASE` 依赖对应目录；部署基础包时应设置 `CATALOG_ENABLED_SET_CODES=BRO,SOS`，再由管理员投递 `catalog.sync`。同步成功前商品显示“等待 BRO/SOS 目录同步”且不可购买；成功后同一事务发布新规则快照并启用。不要手工编辑候选 SKU、商品启用状态或规则 JSON。
- 管理员通过 `POST /v1/admin/catalog/sync` 携带 `Idempotency-Key` 投递任务，再以 `GET /v1/admin/catalog/sync` 或通用任务 API 观察状态。排障必须查看 `catalog_sync_runs` 的版本、SHA-256、差异和失败摘要以及 `job_runs`；不得手工删除目录行、图片或修改任务状态。
- 同步会先下载并校验整个 Bulk 文件（兼容 Scryfall 声明的 gzip 编码），以对象级扫描解析顶层数组而不转换完整文件为 JavaScript 字符串，并在读取时只保留启用系列；下载/解析失败最多重试三次、校验未压缩响应长度，再在短事务中替换 Scryfall 来源目录。任何 checksum、JSON 截断、Schema、重复印刷、图片或 SQLite 错误均保留最近成功目录和 `catalog_sync_state` 指针。修复外部问题后使用新的幂等键重新投递；不要将外部 URL 交给浏览器重试。
- 卡图通过独立 `catalog.image-cache` 任务下载并写入 `CATALOG_DATA_DIR/images`。管理员可按 SKU 或系列投递任务；它仅补齐已有目录的 `missing`/`failed` 图片，不会重新下载 Bulk 或替换目录。持久化卷必须包含该目录；读取仅通过受保护的本地 `/v1/catalog/images/:imageName` 路径，禁止使用目录路径或 Scryfall 图片 URL 作公开静态根。

## I13B MTGJSON Cardmarket 价格同步

- 设置仅服务端可见的 `MTGJSON_PRICES_ENDPOINT`、`MTGJSON_PRINTINGS_ENDPOINT` 和标识服务的 `MTGJSON_USER_AGENT`。任务必须同时读取两个 URL 加 `.sha256` 的侧车校验和；`AllPricesToday` 提供当前日价格，`AllPrintings` 仅用于将 MTGJSON UUID/工艺映射到已导入的 Scryfall SKU，解压后逐张处理而不整体转为 JS 字符串；浏览器不得下载任一文件或读取其原始内容。
- 管理员以新的 `Idempotency-Key` 调用 `POST /v1/admin/prices/sync`，再通过 `GET /v1/admin/prices/sync` 或通用 jobs API 观察运行。可选的两个 expected checksum 仅用于已获准的版本固定导入；不匹配、下载、gzip/JSON、映射或 SQLite 失败都会追加 `failed` 运行和任务错误摘要。
- 成功运行会追加映射与每 SKU 快照，`price_sync_state` 才移动到该运行；无 Cardmarket EUR 正价、零价、缺失或歧义映射均明确标为不可新增交易。失败时不得删除 `price_snapshot_entries`、修改 state 指针、手工改 `tradable` 或把兜底价写成 Cardmarket 价；修复外部输入后重新投递任务。
- 若管理状态的 `checksumBypassAvailable` 为真，页面会要求管理员明确确认后提交 `{ "allowChecksumMismatch": true }`。这是上游文件与侧车 SHA-256 不一致时的最后手段：先保存失败运行与请求 ID，再确认审计中的操作者、任务 ID 和 `price_sync.checksum_bypass_requested` 事实。覆写成功会标记为 `bypassed`；不得用直接改库或普通任务绕过该确认条件。
- 每次失败会在服务端结构化日志输出 `price_sync.validation_failed`（校验阶段）或 `price_sync.failed`（写入阶段），其中包含 `syncRunId`、任务 `jobId`/`attempt`、来源版本、校验文件及预期/实际 SHA-256；不输出下载 URL、Provider 原始响应、密钥或 Cookie。排障先以这些批次标识关联 `price_sync_runs`、`jobs` 与 `job_runs`，再决定是否重新投递或执行已受限的 checksum 覆写。

## I14B 市场重定价

- 成功 `prices.sync` 会以 `price-sync:<syncRunId>` 投递唯一 `market.reprice`；已结算开包等经济事实以 `fact-event:<eventId>` 投递唯一任务。用 `/v1/admin/jobs` 和 `job_runs` 按唯一键、运行 ID 和错误摘要追踪，禁止手工改 `market_quotes`、`market_events`、任务状态或外部快照。
- 处理器只读取最近成功运行中的有效 EUR 快照、已结算事实、当前处于 UTC 生效区间的系列周期/关联/市场事件及版本化参数，写入带参数/原因 JSON 的报价投影。失败时旧报价保持可读；修复数据或代码后只重试原任务，勿通过复制或修改系数补偿。
- 基础市场事件必须同时核对 scope（global/set/sku）、目标、UTC `starts_at`/`ends_at`、5,000–20,000 bp 上限和原因。到期事件自然退出后续重定价；I30B 才会提供受审计的发布/暂停/结束命令，在此之前不允许数据库手工运营。

## I15B NPC 买入排障

- 玩家先读取 `/v1/npc-trades/buy/{skuId}/preview`，再以返回的 `quoteId`、`quoteVersion`、`maxUnitPrice` 和新的 `Idempotency-Key` 调用确认端点。报价过期、价格高于限价、余额不足或额度不足时，要求玩家重新预览；不得通过手工改 `market_quotes`、`npc_trade_limits`、账户或库存来绕过检查。
- 排查成交时，按请求 ID、幂等键或 `npc_trades.id` 关联 `idempotency_requests`、`ledger_entries(reason=npc_buy)`、`inventory_entries(reason=npc_buy)`、`fact_events(npc.trade.settled)`、outbox 与 audit 日志。任何一项缺失应按故障处理，不得手补单条流水；短事务回滚后应不存在经济写入或运行中的幂等占位。
- 当日额度以 UTC `settlement_date` 聚合已结算 `npc_trades`，默认单笔 20、单用户/SKU/日 100，仅可由未来受审计的管理命令改变。额度触发或价格变更不应手动删除历史成交；等待下个 UTC 日或由后续正式配置流程处理。

## I16B NPC 卖出排障

- 玩家先请求 `/v1/npc-trades/sell/{skuId}/preview?quantity=<n|all>`，再用返回的报价 ID/版本、解析后的确切数量、`minUnitPrice` 和新的 `Idempotency-Key` 调用确认端点。`all` 只包含当前可用库存；订单或比赛锁定量必须由其所属流程处理，禁止通过修改库存字段出售。
- 按请求 ID、幂等键或 `npc_trades.id` 关联 `idempotency_requests`、`ledger_entries(reason=npc_sell)`、`inventory_entries(reason=npc_sell)`、`fact_events(npc.trade.settled)`、outbox 与审计记录。任何缺失均按故障处理，不得手补流水、余额、库存、成交或事件。
- 收购价低于玩家确认下限、报价失效、库存锁定/不足或额度不足时，要求重新预览或等待正常库存状态变化；禁止手工修改 `market_quotes`、`npc_trade_limits`、账户、库存或历史成交来绕过校验。

## I18B P2P 双边委托排障

- 玩家先请求 `/v1/orders/buy|sell/{skuId}/preview?quantity=`，再用返回的 `quoteId`/`quoteVersion`/`previewVersion`、玩家确认的 `limitPrice` 和新的 `Idempotency-Key` 调用创建端点。预览的限价带、费用、保证金与 `previewVersion` 完全由服务端计算；客户端回传过期 `previewVersion`/`quoteVersion` 会返回 `409 VERSION_STALE`，需重新预览。
- 创建买单预占 数量*限价+order_fee（`fund_holds`，`entity_type='bilateral_order'`、`reason='order_buy'`）；创建卖单锁定库存（`inventory_holds`，`reason='order'`）并预占保证金（`fund_holds`，`reason='order_fulfillment_deposit'`）。order_fee 不在卖单预占，留到 I19B/I20B 撮合/履约时扣除。
- 按请求 ID、幂等键或 `bilateral_orders.id` 关联 `idempotency_requests`、`fund_holds`/`inventory_holds`/`inventory_entries` 与审计记录。撤单以幂等键 + 状态版本条件 UPDATE 推进状态机 `open|partially_filled → cancelled`，释放对应预占；重复撤单返回 `409 RESOURCE_CONFLICT`。
- 异常定位遵循“禁止直接修数”：余额、库存、保证金、委托状态或预占的任何缺失或漂移，必须由所属模块的补偿命令在同事务写新流水与原因，禁止直接覆盖 `bilateral_orders`、`fund_holds`、`inventory_holdings` 或账户最终值。撮合、模拟履约、`p2p.trade.settled` 与 `order.expire` 定时回收延后至 I19B/I20B/I22B。

## I19B P2P 撮合排障

- 撮合由 `OrderService.match(skuId)` 在独立 `InventoryService.withLedgerTransaction` 短事务执行：创建买单/卖单成功后自动触发一次；运维/测试可经 `POST /v1/orders/{skuId}/match`（admin 角色）显式重跑。撮合失败只记日志、不影响委托创建结果，可重跑安全。
- 撮合顺序与成交价由 `packages/rules` 的 `order-matching/v1` 决定（买单限价降序、卖单限价升序、同价按 rowid 时间优先、成交价取 maker）。成交写一行 `bilateral_trades`（status=`matched_pending_fulfillment`），买方已成交资金转 `order_fulfillment` 待履约 hold，卖方已成交库存部分捕获离开持有（`inventory_holds` 收缩到剩余），卖方保证金按已成交/剩余切分。本期不转移最终所有权、不写 `p2p.trade.settled`、不结算卖方收入/保证金（留 I20B）。
- 并发与幂等：逐 leg 以条件 UPDATE（`WHERE version=? AND remaining_quantity>=?`）扣减双方剩余；`bilateral_trades UNIQUE(buy_order_id, sell_order_id, execution_price_amount)` 保证同一对委托在相同成交价下至多一行成交。并发撮合不会超卖、超扣或重复成交；任一 leg 写入异常整笔回滚。
- 按请求 ID、`bilateral_trades.id` 或 `bilateral_orders.id` 关联 `bilateral_trades`、`fund_holds`（reason=`order_fulfillment`/`order_fulfillment_deposit`）、`inventory_holds`（status=`captured`/`active`）与审计记录（`bilateral_order.matched`）。异常定位遵循“禁止直接修数”：成交、待履约 hold 或委托状态的任何缺失或漂移，必须由补偿命令在同事务写新流水与原因，禁止直接覆盖 `bilateral_trades`、`bilateral_orders`、`fund_holds`、`inventory_holdings` 或账户最终值。模拟履约、`p2p.trade.settled`、取消履约与 `order.expire` 定时回收延后至 I20B/I22B。

## I19F P2P 撮合状态玩家只读视图排障

- `GET /v1/orders/trades`（player 角色）是玩家查看自己成交与待履约资产的唯一入口；服务端以 `OrderService.listPlayerTrades` 从 `bilateral_trades` 投影，脱敏对手 userId、对手 orderId 与所有 holdId。若玩家反馈看不到成交，先按 `bilateral_trades.buyer_user_id/seller_user_id` 核对成交归属，再核对前端是否因连接失败展示「数据可能过期」而非伪造空态。
- 该接口纯读、不写事务、不引幂等键、不写审计；任何缺失或漂移不得通过直接修改 `bilateral_trades` 或前端缓存解决，必须回到撮合/履约（I19B/I20B）与审计链路定位。履约确认/取消（I20B/I20F）与 `order.expire`（I22B）未上线前，待履约资产只可展示、不可操作。

## I30B 管理活动与玩家补偿（计划）

以下是 I30B 实现时必须细化为可执行手册的边界；当前尚未实现，不授权通过数据库手工操作替代后台能力。

- 发布活动前保存服务端预览结果，核对活动/预览版本、UTC 生效区间、作用范围、影响上限与冲突。发布、暂停、结束后记录请求 ID、活动版本、审计记录和关联 `market.reprice` 任务；失败或版本冲突时不得直接改活动表或外部价格快照。
- 冻结/解冻玩家、撤销会话或执行余额/库存补偿前，核对用户 ID、当前状态和影响摘要。补偿必须保留原因、原记录关联、幂等键、新流水及审计；禁止设置最终余额/库存、删除旧流水或跨模块直接修表。
- 排障从只读、脱敏日志按请求 ID、操作者、用户、实体或任务关联追踪。日志页面和运维流程都不得显示密码哈希、令牌、Cookie、密钥或敏感 Provider 原文，也不得删除审计记录。
- I30B 的 MTGJSON 系列/密封产品/补充包导入只能创建待审核草稿：先核对下载版本、SHA-256、Scryfall 系列/SKU 映射、缺失项和服务端预览，再以新的幂等键发布。虚拟币价格、启用范围和运营文案必须由管理员填写；不得把外部密封产品价格、原始 URL 或未审核卡表直接发布给玩家，亦不得通过数据库手工修改已发布规则。

## I17B 价格历史、每日同步与 AllPrices 回填

- 价格历史天然只追加：`price_snapshot_entries` 与 `market_quotes` 均只追加，每日同步/重定价都会产生新行。`GET /v1/market/quotes/{skuId}/history?range=7d|30d|all` 与 `GET /v1/market/index/history?range=...` 按自然日采样；排障时直接查询这两张只读表，禁止手工写入、删除或覆盖历史行来伪造价格曲线。
- 每日同步调度：task runner 以 5 分钟节流轮询 UTC 自然日，落后时投递 `prices.sync:daily:<date>`；`price_sync_schedule_state.last_scheduled_date` 是唯一进度指针。停机多日只补投一次而非逐日补投；同日重放由 `(type, unique_key)` 唯一键收敛。若调度异常，检查 `price_sync_schedule_state`、`jobs` 与 `price_sync_runs`，不要手工改 `jobs` 状态。
- 回填使用独立的服务端配置 `MTGJSON_ALLPRICES_ENDPOINT`（默认 `AllPrices.json.gz`）和 `prices.backfill` 任务。管理员以新 `Idempotency-Key` 调用 `POST /v1/admin/prices/backfill`，再通过 `GET /v1/admin/prices/backfill` 或 jobs API 观察运行。可选的 `expectedPricesChecksumSha256` 仅用于已获准的版本固定回填；`allowChecksumMismatch` 仅在 Provider checksum 不匹配时作为最后手段。
- 回填监督运行（`price_sync_runs.run_kind='backfill'` 且 `mapping_uri='supervisor'`）记录来源版本、SHA-256、日期范围、插入/跳过统计与审计；每个历史日期独立子 run（`mapping_uri='sub-run'`）复用 `UNIQUE(sync_run_id, sku_id)` 约束。它只补齐本地缺失的 `(sku_id, 自然日)`，绝不覆盖每日同步写入、移动 `price_sync_state`/`price_sync_schedule_state` 指针，或为历史日投递 `market.reprice`。
- checksum、解析、映射或事务失败时整笔回滚，只追加一条 `failed` 监督运行并保留原有快照与每日同步状态；待修复后以新幂等键重试。每次失败在结构化日志输出 `price_backfill.validation_failed`（校验阶段）或 `price_backfill.failed`（写入阶段），包含批次 ID、任务 ID/尝试、来源版本、校验文件与预期/实际 SHA-256。禁止手工写入或覆盖 `price_snapshot_entries` 伪造历史。
