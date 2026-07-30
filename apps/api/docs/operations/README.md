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

## I23B 每日工作资金与日切处置

- 部署前设置有效 IANA `APP_TIMEZONE` 与已发布的 `DAILY_WORK_FUNDING_RULE_VERSION`。启动及每 5 分钟轮询会投递当前自然日的 `daily.rollover:<YYYY-MM-DD>`；payload 已快照日期、时区与规则版本，排队任务不得因后来配置变更而被手工改写。
- 日切成功只在 `daily_rollover_runs` 创建资格行；资金实际在玩家 `POST /v1/daily-work-funding/claim` 成功的同一事务中写 `daily_work_funding_claims`、`ledger_entries(reason=daily_work_funding)`、审计和幂等响应。不要通过手工插入领取记录、改账户余额、删除唯一约束或重置任务来“补钱”。
- 排障以请求 ID、幂等键或领取记录 ID 关联 `idempotency_requests`、领取记录、账本和 `daily_work_funding.claimed` 审计；以自然日关联日切任务、`job_runs`、`daily_rollover_runs` 与 `daily.rollover.opened` 审计。停机后只补当前日；先前未执行的任务若恢复，必须保留其 payload 的原日期，不能改成今天。
- I25B 前 `daily.rollover` 不刷新赛事。看到赛事未刷新不是资金任务故障，不得手工重置或创建赛事。

## I09B Scryfall 目录同步

- 首次导入前必须显式设置 `CATALOG_ENABLED_SET_CODES`（英文逗号分隔、系列代码大写）和持久化的 `CATALOG_DATA_DIR`；空系列配置会令任务失败而不会导入完整 Bulk Data。`SCRYFALL_BULK_ENDPOINT` 默认指向 Scryfall `default-cards` 元数据端点，`SCRYFALL_USER_AGENT` 必须标识本服务（建议带运维联系邮箱），两者只允许由 API 进程后台任务访问。Scryfall 会拒绝 Node 默认 User-Agent 并返回 `400 generic_user_agent`。
- `BRO-BASE` 与 `SOS-BASE` 依赖对应目录；部署基础包时应设置 `CATALOG_ENABLED_SET_CODES=BRO,SOS`，再由管理员投递 `catalog.sync`。同步成功前商品显示“等待 BRO/SOS 目录同步”且不可购买；成功后同一事务发布新规则快照并启用。不要手工编辑候选 SKU、商品启用状态或规则 JSON。
- 管理员通过 `POST /v1/admin/catalog/sync` 携带 `Idempotency-Key` 投递任务，再以 `GET /v1/admin/catalog/sync` 或通用任务 API 观察状态。排障必须查看 `catalog_sync_runs` 的版本、SHA-256、差异和失败摘要以及 `job_runs`；不得手工删除目录行、图片或修改任务状态。
- 同步会先下载并校验整个 Bulk 文件：兼容旧版 `download_uri` 顶层数组，以及 Scryfall 新版 `jsonl_download_uri` gzip JSONL；元数据可为直接 `default_cards` 描述器或 `/bulk-data` 列表，后者只选择 `default_cards`。它按对象/行扫描而不转换完整文件为 JavaScript 字符串，并在读取时只保留启用系列；下载/解析失败最多重试三次、校验未压缩响应长度，再在短事务中按 Scryfall 印刷 ID 和 `(printing_id, finish)` 更新目录。已被库存、价格、订单或历史记录引用的 SKU 不会删除，来源快照不再包含的行只在同步差异中记为 `removed`。任何 checksum、JSON 截断、Schema、重复印刷、图片或 SQLite 错误均保留最近成功目录和 `catalog_sync_state` 指针。修复外部问题后使用新的幂等键重新投递；不要将外部 URL 交给浏览器重试。
- 卡图通过独立 `catalog.image-cache` 任务下载并写入 `CATALOG_DATA_DIR/images`。管理员可按 SKU 或系列投递任务；它仅补齐已有目录的 `missing`/`failed` 图片，不会重新下载 Bulk 或替换目录。持久化卷必须包含该目录；读取仅通过受保护的本地 `/v1/catalog/images/:imageName` 路径，禁止使用目录路径或 Scryfall 图片 URL 作公开静态根。

## I13B MTGJSON Cardmarket 价格同步

- 设置仅服务端可见的 `MTGJSON_PRICES_ENDPOINT`、`MTGJSON_PRINTINGS_ENDPOINT`、`MTGJSON_ALLPRICES_ENDPOINT` 和标识服务的 `MTGJSON_USER_AGENT`。三个载荷（`AllPricesToday`、`AllPrintings`、`AllPrices`）均采用流式下载与解析：边下载边计算 SHA-256 并写入 `TMPDIR` 临时文件（单遍、恒定内存），下载失败/截断最多重试 3 次；解析时 `createReadStream →（按 gzip 魔数决定是否 gunzip）→ stream-json` 逐对象产出，绝不把整个文件 `gunzipSync` + `toString("utf8")`（`AllPrices` 历史文件会触发 V8 单字符串上限 `0x1fffffe8`）。校验和比对下载阶段已算出的值，不做二次全量哈希。临时文件在解析后删除。浏览器不得下载任一文件或读取其原始内容。
- 管理员以新的 `Idempotency-Key` 调用 `POST /v1/admin/prices/sync`，再通过 `GET /v1/admin/prices/sync` 或通用 jobs API 观察运行。可选的两个 expected checksum 仅用于已获准的版本固定导入；不匹配、下载、gzip/JSON、映射或 SQLite 失败都会追加 `failed` 运行和任务错误摘要。
- 成功运行会追加映射与每 SKU 快照，`price_sync_state` 才移动到该运行；无 Cardmarket EUR 正价、零价、缺失或歧义映射均明确标为不可新增交易。失败时不得删除 `price_snapshot_entries`、修改 state 指针、手工改 `tradable` 或把兜底价写成 Cardmarket 价；修复外部输入后重新投递任务。
- 若管理状态的 `checksumBypassAvailable` 为真，页面会要求管理员明确确认后提交 `{ "allowChecksumMismatch": true }`。这是上游文件与侧车 SHA-256 不一致时的最后手段：先保存失败运行与请求 ID，再确认审计中的操作者、任务 ID 和 `price_sync.checksum_bypass_requested` 事实。覆写成功会标记为 `bypassed`；不得用直接改库或普通任务绕过该确认条件。
- 每次失败会在服务端结构化日志输出 `price_sync.validation_failed`（校验阶段）或 `price_sync.failed`（写入阶段），其中包含 `syncRunId`、任务 `jobId`/`attempt`、来源版本、校验文件及预期/实际 SHA-256；不输出下载 URL、Provider 原始响应、密钥或 Cookie。排障先以这些批次标识关联 `price_sync_runs`、`jobs` 与 `job_runs`，再决定是否重新投递或执行已受限的 checksum 覆写。

## I14B 市场重定价

- 成功 `prices.sync` 会以 `price-sync:<YYYY-MM-DD>`（下载完成的 UTC 自然日）投递唯一 `market.reprice`；已结算开包等经济事实以 `fact-event:<eventId>` 投递唯一任务。报价新鲜度取决于「本日是否成功 reprice 过」，不再耦合 MTGJSON 的 `meta.date`。用 `/v1/admin/jobs` 和 `job_runs` 按唯一键、运行 ID 和错误摘要追踪，禁止手工改 `market_quotes`、`market_events`、任务状态或外部快照。
- 同一 UTC 日内重复 `market.reprice`（triggerKey 相同）由 `market_quotes` 的 `ON CONFLICT(sku_id, trigger_key) DO UPDATE` 覆盖全部业务字段（价格、参数、reasons、`calculated_at`、`valid_until`）——即「同日只保留最新业务结果」，业务结果按 SKU 维度至多一次；跨日因 triggerKey 不同而保留各自历史版本。`reprice` 返回的「落库行数」语义为新增或覆盖之和，不再是纯新增数。
- 处理器只读取最近成功运行中的有效 EUR 快照、已结算事实、当前处于 UTC 生效区间的系列周期/关联/市场事件及版本化参数，写入带参数/原因 JSON 的报价投影。失败时旧报价保持可读；修复数据或代码后只重试原任务，勿通过复制或修改系数补偿。
- 报价有效期固定 15 分钟（`MARKET_QUOTE_VALIDITY_MS`）。`/v1/npc-trades/*/preview` 与 `/v1/orders/*/preview` 对超过 `valid_until` 的报价返回 `VERSION_STALE`，要求等待服务端刷新——这是预期行为，不是故障。
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
- 该接口纯读、不写事务、不引幂等键、不写审计；任何缺失或漂移不得通过直接修改 `bilateral_trades` 或前端缓存解决，必须回到撮合/履约（I19B/I20B）与审计链路定位。

## I20B 模拟履约、取消与到期排障

- 履约（`POST /v1/orders/trades/{tradeId}/fulfill`）与取消履约（`/cancel`）由 `OrderService.fulfill`/`cancelTrade` 在单 `InventoryService.withLedgerTransaction` 短事务内结算，买卖任一方均可发起，请求体为空、需 `Idempotency-Key`、指纹仅依赖路径。`POST /v1/orders/trades/{tradeId}/expire`（admin）显式触发成交到期回收，普通玩家 `403`。
- **正常履约**的资金/库存规则：买方按成交价结算——先 `releaseOrderFunds` 释放撮合时按买单限价预占的全量 `order_fulfillment` hold，再按 数量×成交价+order_fee 扣款，限价（>= 成交价）的差额退回买方 available；库存以成交价为成本转入买方；卖方 `releaseOrderFunds` 返还保证金、`creditAvailableFunds` 收入（数量×成交价-order_fee）；追加 `p2p.trade.settled`（fact_events + outbox('market.fact-event') + market.reprice 任务，market-service 按 liquidity 消费一次 quantity）。**取消履约**：`releaseOrderFunds` 退回买方全量待履约资金、`captureFunds` 扣除卖方保证金（账本 reason 取 hold.reason=`order_fulfillment_deposit`，correlation=`p2p-deposit-forfeited:{tradeId}`）、`restorePartial` 恢复卖方库存；**不写 `p2p.trade.settled`**。
- 到期回收：`order.expire` 任务由建单/撮合时投递（`uniqueKey=order-expire:{orderId}` / `trade-expire:{tradeId}`，`runAfter=expires_at`/`fulfillment_deadline`），`(type, unique_key)` 唯一索引去重。`OrderService.expireByPayload({kind,id})` 到期把委托转 `expired`（释放剩余预占）或成交转取消履约；状态机条件 UPDATE 保证已 fulfilled/cancelled 不重复迁移。履约期限沿用 `bilateral_order_limits.ttl_seconds`，由 `order-fulfillment/v1`（`resolveFulfillmentDeadline`）派生，写入 `bilateral_trades.fulfillment_deadline`。
- 并发与幂等：履约/取消在短事务内串行，条件 UPDATE（`WHERE status='matched_pending_fulfillment'`）保证至多一次业务结果；同键同参重放返回首次响应，异参 `IDEMPOTENCY_CONFLICT`。事务回滚测试（`fail_trade_update` 触发器）验证写入异常时无半完成状态、资金/库存/保证金守恒。
- 按 `bilateral_trades.id` 关联 `fund_holds`（`buyer_funds_hold_id`=`order_fulfillment`、`seller_deposit_hold_id`=`order_fulfillment_deposit`）、`inventory_holds`（卖方 `seller_inventory_hold_id`）、`ledger_entries`（`p2p_buy`/`p2p_sell`/`order_fulfillment_deposit`）、`fact_events`（`p2p.trade.settled`）与审计（`bilateral_trade.fulfilled`/`.cancelled`/`.expired`）。异常定位遵循“禁止直接修数”：任何缺失或漂移必须由补偿命令在同事务写新流水与原因，禁止直接覆盖 `bilateral_trades`、`fund_holds`、`inventory_holdings`、`accounts` 最终值或删除流水/审计。撮合风控（价格边界/频率/自成交标记）延后至 I21B；端到端一致性恢复回归属 I22B。

## I21B 订单风控排障

- 用请求 ID 或订单 ID 查询 `order_risk_decisions` 与 `audit_logs(entity_type='order_risk_decision')`；`blocked` 发生在资产预占前，禁止通过直接改订单、余额、库存或决策行“放行”。
- `self_trade`、`price_out_of_band`、`cooldown`、`order_frequency`、`quantity_limit` 均拒绝；`cancellation_frequency` 是只读复核标记，撤单资产已按原事务释放。

## I22B P2P 全链路一致性与恢复

- **异常订单定位**：从订单 ID、成交 ID、请求 ID 或幂等键开始，只读关联 `bilateral_orders`、`bilateral_trades`、`fund_holds`、`inventory_holds`、`ledger_entries`、`inventory_entries`、`fact_events`、`jobs`、`job_runs` 与 `audit_logs`。部分成交必须分别核对未成交委托的 `remaining_quantity`/active hold 与每笔待履约成交的 hold；不可只按订单汇总金额判断正确性。
- **对账恒等式**：账户始终满足 `total_amount = available_amount + frozen_amount`；买单的 active `order_buy`/`order_fulfillment` hold 与订单剩余/待履约金额一致；卖单的 active inventory hold 与未成交锁定数量一致，已 capture 的数量只可由已完成、取消或到期成交解释；保证金只能是 active、released 或 captured，取消/到期的 captured 保证金必须有 `ledger_entries(reason=order_fulfillment_deposit, correlation_id=p2p-deposit-forfeited:{tradeId})`。正常履约必须有唯一 `p2p.trade.settled`，取消或到期则不得有该事实事件。
- **重启与任务恢复**：重启前保留 SQLite WAL 及数据库文件；新进程启动时 task runner 会恢复租约过期的 job，并以 `(type, unique_key)` 继续收敛 `order.expire`。检查 `jobs.status/attempts/locked_until` 与 `job_runs` 后让 worker 正常领取；不得通过直接更新订单状态、hold、库存或余额来“补偿”到期任务。已终态订单/成交被重复领取必须是无副作用跳过。
- **人工冻结与处置边界**：发生疑似漂移时，先停止相关写流量并保留数据库/WAL、请求 ID、任务和审计证据；在 I30B 的受审计玩家冻结命令上线前，不存在授权的按玩家数据库手工冻结路径。不得以删任务、修改 `bilateral_orders`、`bilateral_trades`、`fund_holds`、`inventory_holdings` 或账户最终值代替冻结。恢复或补偿只能由所属 application 命令在同一短事务写新流水、原因和审计；无法安全处置时保持冻结并升级。

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

## I25B 比赛排障

- 日切任务在打开工作资金资格后，为已有用户按 `(template_id, natural_date, owner_user_id)` 创建隔离赛事；重复领取或停机补跑由唯一约束收敛。核对 `daily_rollover_runs`、`tournaments.natural_date/timezone/seed_hash` 和模板版本；禁止手工新增、重置、改 seed 或改状态。
- NPC 报名以请求 ID、幂等键或 `tournament_registrations.id` 关联 `tournament_deck_card_snapshots`、`deck_power_snapshots`/加密 Leyline 源记录、`inventory_holds(reason=tournament)`、`ledger_entries(reason=tournament_entry)`、审计和 `tournament-settle:registration:{registrationId}`。Provider/禁牌/库存失败时这些报名与经济记录都不应出现。
- 结算从报名 ID 关联 `tournament_results`、`tournament_reward_draws`（seed、候选池、版本、命中项）、`tournament_rewards`/`tournament_pack_grants`、比赛 hold、`ledger_entries(reason=tournament_reward)`、`fact_events(event_type=tournament.settled)` 与审计。重领任务只读取既有结果；发现漂移时停止写流量、保留数据库/WAL/请求证据，绝不直接更新奖励、报名、库存、账本或结果。
- 补充包奖励凭证由 `tournament_pack_grants` 的 `available → claimed` 条件更新消费；按 grant ID 关联 `pack_openings`、`pack_rule_replays`、入库流水、`pack.opened`、outbox 和两类审计。下架不取消已发凭证，但失效候选 SKU 会使领取完整回滚，待修复受控目录后用新幂等键重试。
- 玩家游戏内赛事检查 `jobs.unique_key=tournament-settle:player:{tournamentId}`、`player_tournament_registration_holds`、`player_tournament_deck_card_snapshots`、`player_tournament_results`、`player_tournament_reward_draws`/`player_tournament_rewards` 与每个报名的 `tournament.settled`；现实桌检查 `player_tournament_rounds`（含 `stage=playoff`）、全桌 `player_tournament_round_confirmations` 和 `tournament_disputes`。玩家补充包凭证位于 `player_tournament_pack_grants`，按与 NPC 凭证相同的 `available → claimed` 条件更新和开包回滚规则处理。种子/完整 replay 仅可由 admin 读取；普通玩家查询不到即按权限边界处理，不得通过数据库导出补发。
