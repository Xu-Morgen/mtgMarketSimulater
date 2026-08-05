## I34B 市场行情与交易体验服务端 — 实现计划

严格按《完整项目迭代实施计划与检查清单》I34B 的 7 个 checklist 项落地，遵循 AGENTS.md 权威边界（Fastify+SQLite 唯一写入者、浏览器只展示服务端结果、规则只放 packages/rules、经济操作单事务、幂等键、审计）。

### 0. 新增内容总览（按模块）

| 迁移 0036 | watchlist 表 + market_parameters 倾向列 |
| contracts | 新 DTO/错误语义/盘口扩展 + 契约测试 |
| market 模块 | `heat`、`announcements`、bias 因素、`parseReasons` 支持 bias |
| orders 模块 | `POST /v1/npc-trades/sell/batch`、订单簿深度扩展 |
| watchlist 新模块 | CRUD + 提醒任务 + 通知查询（api/application/domain） |
| jobs 模块 | 注册 `watchlist.check` 任务类型与投递助手 |
| admin 模块 | market-parameters DTO/schema/仓储/服务扩展 bias 字段 |
| openapi.ts | 新增/变更路径同步 |

### 1. 迁移 `0036_market_heat_watchlist.sql`

- `ALTER TABLE market_parameters ADD COLUMN npc_bias_bps INTEGER NOT NULL DEFAULT 10000 CHECK (npc_bias_bps BETWEEN 5000 AND 20000)`、`ADD COLUMN npc_bias_reason TEXT NOT NULL DEFAULT 'NPC 做市商倾向'`（全局倾向因素，默认 10000 中性，保持既有行为）。
- `watchlist_items(id, user_id, sku_id, target_type CHECK('game_price'|'reference_price'), direction CHECK('at_or_below'|'at_or_above'), target_amount, enabled, created_at, updated_at)`，`UNIQUE(user_id, sku_id)`（每玩家每 SKU 去重）。
- `watchlist_alerts(id, user_id, watchlist_item_id, sku_id, target_type, direction, target_amount, triggered_quote_id, triggered_price, triggered_at, read_at)`，`UNIQUE(user_id, watchlist_item_id, triggered_quote_id)`（同一报价只产生一次提醒，至多一次通知）。
- `watchlist_limits` 单例（max_items_per_user=50）与 `rule_versions` 固定行。
- 沿用既有约定：TEXT PK、整数金额、CHECK、索引、UTC ISO、单例 `ON CONFLICT DO NOTHING`、文件头注释 `-- I34B：...`。

### 2. packages/contracts

- `MarketFactorInput["kind"]` 与 `QuoteDto.reasons.kind` 联合类型加 `"bias"`。
- 新增：`MarketHeatEntryDto`（sku 摘要 + changeBps + changeAmount + direction + 排名来源说明）、`MarketHeatDto`（`intraday`/`sevenDay` 各涨跌 top10 + `mostActive` top10 + capturedAt）。
- 新增：`BatchNpcSellItemDto`、`BatchNpcSellSkipReason`（`not_held`/`no_available_quantity`/`quote_unavailable`/`quote_stale`/`trade_limit_reached`）、`BatchNpcSellResultDto`（soldItems/skippedItems/cardCount/income/fee）。
- 新增：`WatchlistItemDto`、`WatchlistAlertDto`、`WatchlistLimitsDto`、`WatchlistAlertsDto`。
- 新增：`MarketAnnouncementDto`（type `series_cycle`|`market_event`、title、scope、setCode/setName/skuName 可选、startsAt、endsAt、reason；**不含 factorBps 等内部系数**）、`MarketAnnouncementsDto`。
- 扩展：`BilateralOrderBookLevelDto` 加 `cumulativeQuantity`（服务端逐档累计）；`BilateralOrderBookDto` 加 `midPrice: Money|null`、`spread: Money|null`。
- 扩展：`AdminMarketParametersDto` 加 `npcBiasBps`/`npcBiasReason`。
- 契约测试：断言公告 DTO 序列化后无 `factorBps` 等内部字段；watchlist/batch 新 DTO 固定形状；盘口扩展字段序列化稳定。

### 3. packages/rules

- `MarketFactorInput.kind` 联合类型加 `"bias"`（`calculateMarketQuote` 本身只校验 bp 界与 reason，无需改计算逻辑；规则版本保持 `market/v1`，bias 缺省时结果与既有完全一致）。

### 4. market 模块（MarketService + market-routes.ts）

- `heat(now)`：基于 `market_quotes` 按自然日采样（复用 I17B `substr(col,1,10)` 模式），每 SKU 取最新报价与上一采样日/7 日前报价，服务端整数计算 changeBps 与方向，排序取涨/跌前 10；`mostActive` 按 `npc_trades`+已履约 `bilateral_trades` 当日聚合（数量、金额、买卖方向）。只读、不写。
- `announcements(now)`：只读聚合生效期内的 `market_series_cycles`（JOIN card_sets）与 `market_events`（JOIN admin_campaigns 取 name/display_text 作标题），不暴露 factor_bps。
- `factorsFor`：reprice 时把 `parameters.npc_bias_bps`/`npc_bias_reason` 作为 `{kind:"bias",...}` 因素加入（仍受 5000–20000 汇总截断约束）；`parseReasons` 接受 `"bias"`；`ParametersRow` 读取新列。
- routes：`GET /v1/market/heat`、`GET /v1/market/announcements`（player 角色，只读）。

### 5. orders 模块

- `NpcTradeService.sellBatch(input: { userId, skuIds, idempotencyKey, requestFingerprint, requestId, now })`：单事务、幂等（复用 findIdempotency/complete 模式）。逐 SKU：报价/过期/持有检查 → 卖出 `min(available_quantity, remainingDaily, maxPerTrade)`（**不保留一张**，区别于 C8 重复卡）→ `disposeAvailableInLedgerTransaction` + `creditForNpcSell` + `npc_trades` 行 + `writeSettlementEvent`/outbox + `enqueueMarketRepriceJob` + 审计（batch 标记）；失败整批回滚。返回 `BatchNpcSellResultDto`。
- route：`POST /v1/npc-trades/sell/batch`，body `{ skuIds: string[] }`（uuid、1–100、去重），幂等键 + canonicalizeRequest 指纹。
- `OrderService.book`：按价格档聚合后追加逐档 `cumulativeQuantity`，并计算 `midPrice`（最优买/卖中间价，整数）与 `spread`（最优卖-买，整数），无任一档为 null；仍只读服务端聚合。

### 6. watchlist 新模块 `apps/api/src/modules/watchlist/`

- `domain/watchlist.ts`：纯函数（目标值校验、命中判定 `hitWatchlistTarget`、`WATCHLIST_MAX_ITEMS=50` 常量）。
- `application/watchlist-service.ts`：
  - `list(userId)` / `upsert({userId, skuId, targetType, direction, targetAmount, enabled, requestId})`（INSERT ON CONFLICT(user_id,sku_id) DO UPDATE，超上限返回 `RULE_VIOLATION`，写审计） / `remove(userId, skuId)`（幂等，审计）。
  - `alerts(userId)`：分页只读未读+近期提醒。
  - `markAlertRead({userId, alertId})`：只更新自己、条件 UPDATE、审计。
  - `checkAlerts({jobId?})`：任务入口；在同一事务内对全部启用 watchlist 项按最新报价执行 `hitWatchlistTarget`，命中写 `watchlist_alerts`，`UNIQUE` 收敛并发/补跑；**只读价格、不写任何经济表**；失败不影响价格与市场（任务失败走既有重试）。
- `api/watchlist-routes.ts`：`GET /v1/watchlist`、`POST /v1/watchlist`（写、幂等键）、`DELETE /v1/watchlist/:skuId`（写、幂等键）、`GET /v1/watchlist/alerts`、`POST /v1/watchlist/alerts/:id/read`（写、幂等键）。
- app.ts 注册；openapi.ts 加 5 个路径。

### 7. jobs 模块

- `registeredJobTypes` 加 `"watchlist.check"`；`task-service.ts` 加 `enqueueWatchlistCheckJob(database, uniqueKey, runAfter)`。
- `task-runner.ts`：`market.reprice` handler 在 `market.reprice(...)` 成功后 `enqueueWatchlistCheckJob(database, 'watchlist.check:reprice:'+triggerKey, now)`；注册 `watchlist.check` handler → `watchlist.checkAlerts()`。提醒任务失败不影响 reprice 结果。

### 8. admin 模块

- `SqliteMarketParametersRepository`：get/update/toDto 增加 npc_bias_bps/npc_bias_reason；`marketParametersBodySchema` 加两字段（bp 界 5000–20000、reason 1–120 字）；`AdminService.updateMarketParameters` 传递并写审计；管理端测试同步。

### 9. 测试

- contracts：新 DTO 序列化断言（含公告不泄露内部系数）。
- rules：无逻辑变更；确认现有 market 测试不受 bias 类型联合影响（跑通即可）。
- market：`market-service.test.ts` 增补 heat 聚合（含跨日采样、无历史 SKU 处理）与 announcements（到期不返回、无 factorBps）；bias 因素进入 reprice 的 reason 断言。
- orders：`npc-trade-batch.test.ts`（新文件，临时 SQLite + Fastify inject）：批量卖出成功/幂等重放/同键异参 409、跳过项（未持有/无可用/报价缺失过期/额度用尽）、任一失败整批回滚、库存/账本/成交/事件原子性、请求体校验；订单簿 depth 断言（cumulativeQuantity/midPrice/spread/空盘口 null）。
- watchlist：`watchlist-routes.test.ts`（新文件）：CRUD/每 SKU 去重/上限 50/停用后不提醒/checkAlerts 幂等（同 quote 不重复提醒、不同 quote 各提醒一次）/越权删除他人提醒 404/无存档仍可管理 watchlist。
- admin：market-parameters 测试补 bias 字段更新与界外校验。
- 全仓：`pnpm check`、`pnpm --filter @mtg-market/api test`、contracts/rules/database/web 相关测试。

### 10. 文档与收尾

- `apps/api/src/openapi.ts` 同步 7 个路径；检查 openapi 测试。
- 更新 `项目协作文档索引.md` 基线（I34B 条目）、`后端需求.md` 模块能力段落（如需）、`progress/I34B.md`（按模板：新增/修改/删除文件清单 + 特殊点：幂等/审计/权威边界/无新错误码）。
- 不运行 e2e（AGENTS.md 第 7 节 E2E 策略，I34F 由用户在手动测试记录补登）。

### 风险与取舍
- 全局倾向因素（用户已确认）：`npc_bias_bps` 默认 10000 中性，不改变既有报价结果；管理端可条件更新并经 reprice 生效。
- 提醒检测绑定 `market.reprice` 成功后投递（每次价格刷新自然触发），任务失败走既有重试与指数退避，绝不影响报价。
- 公告 API 不暴露 factor_bps 等内部系数，符合 checklist「不暴露内部系数与配置」。