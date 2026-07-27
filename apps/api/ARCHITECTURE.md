# API 项目架构

本目录承载 Fastify API 与单进程后台任务循环，是余额、库存、订单、开包和比赛结算的唯一写入端。项目采用模块化单体；模块在同一进程和 SQLite 数据库中运行，但源码依赖必须保持单向。

## 分层与依赖

```text
api (HTTP / OpenAPI) → application (用例、事务编排) → domain (规则、模型、不变量)
                                             ↓
                                  infrastructure (SQLite、外部服务、文件)
```

- `api` 只处理鉴权、输入输出 DTO、幂等键和 HTTP 状态；不得写 SQL 或经济规则。
- `application` 是唯一的用例入口，负责短事务、授权、调用领域规则与审计事件。
- `domain` 不依赖 Fastify、SQLite、环境变量或外部 SDK；跨业务计算优先调用 `@mtg-market/rules`。
- `infrastructure` 实现仓储、外部数据源与适配器；不得承载业务决策。
- 模块之间通过对方 `application` 暴露的查询/命令接口或 `contracts` 事件协作，禁止跨模块访问数据库表或基础设施实现。

## 目录约定

- `src/bootstrap`：进程组合、生命周期和路由注册。
- `src/config`：环境变量解析和受版本控制的运行配置。
- `src/shared`：跨模块的技术性通用能力，不放业务概念。
- `src/modules`：按业务能力划分的垂直模块。
- `src/platform`：外部服务、存储、安全等可替换技术适配；SQLite schema、迁移和事务工具由 `@mtg-market/database` 提供。
- `src/tests`：测试支撑与分层测试。
- `docs`：架构决策、API 约定和运维手册。
- `data`：运行时持久化数据，不放源码；必须挂载为 Docker 持久化卷。

`@mtg-market/database` 是唯一的 SQLite schema、迁移、连接 pragma、完整性检查和短事务入口。API 的 `src/database.ts` 仅为启动层适配器；各业务模块不得自行建表或执行迁移。迁移在启动、应用开始处理请求和任务前完成；每个迁移在独立 SQLite 事务中原子应用，迁移记录只在同一事务成功后写入。

## HTTP 横切能力（I04）

- `src/app.ts` 是可注入的 Fastify 应用工厂；`server.ts` 只负责组合数据库、任务循环和进程生命周期，集成测试不得监听实际端口。
- 所有 HTTP 成功与失败结果使用 `@mtg-market/contracts` 的统一包络，并通过 `X-Request-Id` 回传请求关联标识。未知路由、Zod 输入校验和未处理异常分别映射为稳定错误码。
- 日志使用 Fastify 内置 Pino，统一脱敏 `Authorization`、Cookie、API key、密码和令牌字段。写路由由横切 hook 记录调用者（I06B 身份接入前为空）、幂等键、路由实体和响应摘要；业务用例仍须在自身事务内写入经济审计事实。
- CORS 仅允许 `CORS_ORIGINS`（未配置时回退为单个 `WEB_ORIGIN`）；不得使用反射式任意 Origin。
- `/health` 提供存活检查，`/ready` 同时检查 SQLite 查询和任务状态摘要。公开协议文档源位于 `src/openapi.ts`，并由集成测试校验公开路由集合。

## 持久化任务（I05）

- `modules/jobs/domain` 定义固定任务类型、状态机和退避；`application` 只编排注册表、启动恢复与处理器调用；`infrastructure` 是唯一能访问 `jobs`/`job_runs` 的 SQLite 仓储。
- worker 每次通过 SQLite 条件更新领取一项任务，并以 `active_run_attempt` 为 `job_runs` 写入全局单调运行记录；手动重试可重置调度尝试计数，但绝不复用不可变历史 attempt。`running` 任务以租约保护；启动时或领取前会关闭过期运行记录并将任务恢复到 `pending`，耗尽尝试次数则转为 `dead`。处理器必须把经济结果设计为幂等，worker 提供的是至少执行一次的调度，不替代业务事实唯一约束。
- 任务按进程串行执行并在优雅关闭时停止新领取、等待在途处理完成。I05 注册的处理器为安全占位符；后续业务迭代必须用对应模块的 application 用例注册替换，不能在 jobs 模块内实现结算。

## 认证与角色（I06B）

- `modules/auth` 持有注册、密码验证、会话轮换、注销和当前会话查询；密码只以 Argon2id 哈希保存，access token 由服务端 HMAC 密钥签发且短期有效，refresh token 仅以 SHA-256 摘要保存在 SQLite。
- refresh token 使用 `HttpOnly; SameSite=Strict; Path=/v1/auth` Cookie；配对的非 HttpOnly CSRF Cookie 必须与 `X-CSRF-Token` 同时通过服务端会话摘要校验，生产环境额外标记 `Secure`。重放已轮换的令牌会撤销其后续轮换链。
- 认证 pre-handler 为请求附加已验证的 actor，并在读取受保护资源时复核会话未撤销、未过期。`requireRole("admin")` 保护全部 `/v1/admin/*` 路由；认证写路由使用单机内存滑动窗口作基础频率限制，部署多实例时必须替换为共享限流实现。

## 存档、账户与账本（I07B）

- `modules/users` 是游戏存档、`GAME_CREDIT` 账户、初始资金与账本查询的唯一入口。`game_archives.user_id` 和 `accounts(user_id, currency)` 均为唯一约束；创建存档会在同一 SQLite 短事务内写入存档、账户、版本化初始资金流水、业务审计及已完成幂等响应。
- 初始资金只通过 `@mtg-market/rules` 的 `initial-funds/v1` 解析；规则定义也保留在 `rule_versions`。账户数据库约束强制 `total = available + frozen` 且三者非负，禁止任何 API 或未来模块直接设置余额。
- `SqliteUserRepository` 暴露 reserve/release/capture 三种共享资金原语。reserve 仅将可用额转入冻结额并附带业务实体关联；release 原样返还；capture 从冻结额扣除总额并写 debit 账本。订单和履约保证金必须由其所属 application 用例在同一短事务中调用。

## Scryfall 目录同步（I09B）

- `platform/external/scryfall` 是唯一可访问 Scryfall Bulk Data 与卡图 URL 的适配器。适配器使用仅服务端可配的自定义 User-Agent，兼容 gzip Bulk 文件，并以对象级扫描避免将完整 Bulk 文件转为 JS 字符串；浏览器目录路由只读取 SQLite，任务下载完成后校验 JSON、启用系列、印刷 ID、工艺与可选 checksum，绝不把 Provider 原文转发给客户端。
- `modules/catalog/application/CatalogSyncService` 先在内存中验证 Bulk 文件，再在一个 SQLite 短事务内替换 `scryfall` 来源的目录行；任何下载、解析、Schema、重复印刷或事务错误都只新增失败运行记录，不删除最近成功目录或其状态指针。`CatalogImageCacheService` 是独立的补图用例，只读取既有目录的图片地址并更新对应缓存元数据，不重导入目录。
- 迁移 `0013_base_bro_sos_packs.sql` 仅创建停用的 `BRO-BASE`、`SOS-BASE` 商品和可公示 bootstrap 卡位；`CatalogSyncService` 在目录替换短事务内调用 packs application 的 `BasePackCatalogService`，从当前 `BRO`/`SOS` 非闪 Scryfall SKU 生成新规则版本、退休旧快照并启用完整卡池。候选 SKU 不写死在迁移中，目录同步失败也不会改变现有基础包规则。
- `catalog_sync_runs` 只追加来源版本、SHA-256、启用系列、导入差异与失败摘要；`catalog_sync_state` 只指向最近成功运行。`catalog.sync` 由 task runner 注册到 catalog application，而不是在 jobs 模块实现业务写入。
- 图片仅能由 `catalog.image-cache` 任务写入 `CATALOG_DATA_DIR/images`，文件名由服务端打印 UUID 和受限扩展名产生；`/v1/catalog/images/:imageName` 认证后只提供该目录内的本地文件，拒绝路径穿越和外部图片 URL。

## 库存真相层（I10B）

- `modules/inventory` 是持有量、可用量、订单锁定、比赛锁定、移动平均成本及市值快照字段的唯一写入口。`inventory_holdings` 的数据库 CHECK 强制 `quantity = available_quantity + order_locked_quantity + tournament_locked_quantity`，所有数量和成本均不得为负。
- 订单和比赛只能通过持久化 `inventory_holds` 的 active 状态锁定库存；释放和扣减（capture）都以条件更新改变同一 hold，禁止超额解锁、重复扣减或同一 SKU 在订单和比赛间重复占用。`inventory_entries` 只追加，记录每次变更的四种数量差额、变更后数量、成本和关联标识。
- `InventoryService.withLedgerTransaction` 是跨模块经济编排接口：开包、订单或比赛必须在其 callback 中同时写库存、资金账本、事实事件与审计。callback 任何失败会回滚整笔 SQLite 短事务。玩家只可读取 `/v1/inventory`、单卡持仓和对账；没有直接修改或解锁 HTTP 路由。

## MTGJSON 价格快照（I13B）

- `platform/external/mtgjson` 是唯一下载 `AllPricesToday` 与 `AllPrintings` 的适配器。它默认校验各文件同 URL 的 `.sha256` 侧车文件，只接受 Cardmarket `EUR` retail 的 latest-date `normal`/`foil`/`etched` 数值，记录两份下载的 SHA-256；`AllPrintings` 解压后按单张 `cards` 对象进行字节扫描与解析，绝不将整份文件转换为单一 JavaScript 字符串。Provider 原文、下载 URI 与 User-Agent 不通过 HTTP 输出。
- `modules/pricing/application/PriceSyncService` 以 AllPrintings 的 Scryfall ID、MTGJSON UUID 和工艺精确对应本地 SKU，并在一笔 SQLite 短事务中追加 `price_sync_runs`、`price_sku_mappings`、每 SKU 的 `price_snapshot_entries` 和物化 `card_skus.tradable`。无价、零价、币种不符、缺映射或歧义映射均追加明确不可用原因并暂停新增交易；成功运行才移动 `price_sync_state` 指针，失败不会替换旧快照。
- `prices.sync` 在 task runner 注册到 pricing application；`/v1/admin/prices/sync` 仅管理员读写，写入以幂等键去重投递任务。仅当最近一次运行持久化为 `CHECKSUM_MISMATCH` 时，管理员可提交 `{ allowChecksumMismatch: true }` 的独立覆写任务；该任务写入专门审计事实，成功运行标为 `bypassed`，不影响普通严格校验路径。每次成功同步以成功运行 ID 唯一投递 `market.reprice`；它不改写库存估值或经济流水。

## 价格历史、每日同步与历史回填（I17B）

- 价格历史天然只追加：`price_sync_runs`/`price_snapshot_entries` 与 `market_quotes` 从不 UPDATE/DELETE，每次每日同步与重定价都产生新行。`MarketService.history`/`indexHistory` 按自然日（`substr(captured_at,1,10)`）采样，同日多次同步/重定价取该日最新值；任一价格缺失为 `null`，空历史返回空数组。历史查询是纯只读投影，不为历史另建存储表，避免与 append-only 设计漂移。
- 每日同步由 `ensureDailyPriceSyncScheduled`（jobs application）在 `startTaskRunner` 的 5 分钟节流轮询中以 UTC 自然日唯一键调度。`price_sync_schedule_state` 单例独立于 `price_sync_state`（最近成功运行指针）：前者记录“已为该自然日投递过 `prices.sync`”，后者记录“最近一次成功的快照运行”。停机多日只补投一次而非逐日补投；`daily.rollover` 的发钱/赛事刷新延后至 I23B/I25B。
- `prices.backfill` 是独立注册任务类型，下载独立的 `MTGJSON_ALLPRICES_ENDPOINT`（`AllPrices`）。`PriceBackfillService` 以每 SKU 最新成功映射为准，按 `(sku_id, 自然日)` 只追加缺失的历史快照：监督 run（`mapping_uri='supervisor'`，`run_kind='backfill'`）汇总统计与日期范围，每个历史日期独立子 run（`mapping_uri='sub-run'`）复用 `UNIQUE(sync_run_id, sku_id)`。它绝不更新 `price_sync_state`/`price_sync_schedule_state`、不为历史日投递 `market.reprice`；解析/校验/写入在一笔短事务内完成，失败整笔回滚。
- `PriceSyncRunDto.runKind` 区分 `daily`/`backfill`；`PublicPriceStatusDto.disclaimer` 由服务端固定数据源与资产性质说明，浏览器只展示。

## 市场报价投影（I14B）

- `modules/market/application/MarketService` 只读取 `price_snapshot_entries`、已结算 `fact_events` 和版本化市场配置，使用 `@mtg-market/rules` 的 `market/v1` 物化 `market_quotes`。它不是余额、库存或外部价的写入者；外部快照保持只追加，经济事实仅被聚合消费。
- `market_parameters` 保存 EUR 欧分到游戏币的整数 bp 兑换、最低报价、NPC 买卖价差与费用；`market_series_cycles`、`market_card_relations` 与 `market_events` 分别表达系列周期、关联传播和有作用域/UTC 生效区间/上限的基础事件。数据库与规则包共同限制系数为 5,000–20,000 bp，过期事件不会进入新投影。
- 同一 `(sku_id, trigger_key)` 的报价只可写入一次。价格同步以 `price-sync:<runId>`、开包事实以 `fact-event:<eventId>` 投递重定价，因此 worker 至少执行一次时仍不会重复累乘；失败任务保留最近成功报价，由 jobs 的退避与重试处置。`market/v1` 以计算时间生成固定 15 分钟有效期，外部快照采集时刻仍单独保留，避免日快照在当天稍后重定价时立即失效。
- `GET /v1/market/quotes/{skuId}` 与 `GET /v1/market/index` 仅返回已持久化的服务端报价/指数，均要求已认证会话。无有效外部价或尚未完成投影的 SKU 返回 `PRICE_UNAVAILABLE`；浏览器不得提交系数、价格或报价参数。

## NPC 买入结算（I15B）

- `modules/orders/application/NpcTradeService` 是玩家向 NPC 买入的唯一命令入口。它只经 `MarketService.npcSettlementQuote` 读取 `market_quotes` 快照、经 users application 写 `npc_buy` 账本、经 inventory application 入库；Orders 模块不跨界读写对方表。
- `npc_trades` 只追加成交记录，并以 `quote_id`、规则版本、单价、内含手续费、总价、数量和 UTC 结算日固定成交输入。`npc_trade_limits` 保存服务器单笔和单用户/SKU/自然日上限；当日额度由已结算记录聚合，前端不得提交额度、价格或手续费。
- `GET /v1/npc-trades/buy/{skuId}/preview?quantity=` 返回服务端选择的不可变报价 ID、规则版本、限价确认所需单位价、费用、总价与剩余额度。`POST /v1/npc-trades/buy/{skuId}` 必须携带报价 ID/版本、数量、最高单位价和 `Idempotency-Key`；报价缺失/不可交易、过期、版本或限价不符、余额不足、交易量超限都不会产生半完成记录。
- 成功结算在一个 `InventoryService.withLedgerTransaction` 中写账本、库存流水、`npc_trades`、`npc.trade.settled`、outbox、唯一 `market.reprice` 任务、业务审计与幂等响应。任一写入失败回滚整笔结算；同一 actor/key 由 `idempotency_requests` 唯一约束收敛为一次结果。

## NPC 卖出结算（I16B）

- 同一 `NpcTradeService` 是玩家向 NPC 卖出的唯一命令入口。它经 `MarketService.npcSettlementQuote(skuId, "sell")` 读取 `npc_buy_*` 收购快照，经 inventory application 仅扣减可用库存，经 users application 写 `npc_sell` credit 账本；Orders 模块不跨界写市场、账户或库存表。
- 卖出预览支持正整数或 `quantity=all`；后者只在服务端解析当前 `availableQuantity`，再把解析后的正整数用于确认。锁定数量继续由订单/比赛所属模块持有，卖出命令不能释放、扣减或绕过任一 hold。
- 确认包含 `minUnitPrice`，服务端拒绝低于确认下限的收购价。成功路径与买入同在一个短事务追加成交、账本、库存流水、事实/outbox、唯一重定价任务、审计和幂等响应；任一异常会回滚全部写入。

## P2P 双边委托预览与创建（I18B）

- `modules/orders/application/OrderService` 是玩家双边委托的唯一命令入口。它经 `MarketService.quote` 读取 `market_quotes.market_price` 作为限价锚点，经 users application 预占/释放资金（`fund_holds`、`entity_type='bilateral_order'`），经 inventory application 锁定/释放库存（`inventory_holds`、`reason='order'`）；Orders 模块不跨界写市场、账户或库存表。
- 预览由 `@mtg-market/rules` 的 `order/v1` 计算限价带（`market_price ± limit_price_band_bps`，下限不低于 `minimum_price`）、order_fee 与 fulfillment_deposit，并派生 `previewVersion`（报价 ID+版本+方向+数量+带+预占金额）。买单预占 数量*限价+order_fee；卖单锁定库存并只预占 fulfillment_deposit，order_fee 留到 I19B/I20B 撮合/履约时扣除。
- 创建、预占与锁定共享 `InventoryService.withLedgerTransaction` 一个短事务，回滚不留半完成委托、资金/库存预占或幂等占位。撤单以幂等键 + 状态版本条件 UPDATE 推进 `open|partially_filled → cancelled` 并释放对应预占；重复撤单返回 `RESOURCE_CONFLICT`。订单簿只读，买单按价格降序、卖单按价格升序聚合，不含用户身份。
- 撮合（价格-时间优先、成交价、部分成交）、模拟履约、`p2p.trade.settled` 事实事件与 `order.expire` 定时回收延后至 I19B/I20B/I22B；本期委托只处于 `open` 状态。

## 库存卖出与估值投影（I16F）

- `InventoryModule` 的只读 DTO 在 SQLite 查询中以当前持久化 `market_quotes` 投影服务端单张游戏内价、全部持有市值与未实现盈亏；计算只使用整数，市值按全部持有量（含订单/比赛锁定量）而非可用量展示。报价缺失时保留最近持仓估值，单张现价为 `null`；完全无估值时以明确不可用状态返回。
- `/inventory` 的卖出入口只可提交数量或 `all` 意图给 Orders application。`all`、锁定量、费用、收入、最低价保护和最终库存全由 `NpcTradeService` 的预览/成交处理，浏览器不读取库存字段来扣减或计算盈亏。

## 补充包规则（I11B）

- `modules/packs` 持有补充包商品、活动规则版本、卡位与候选池。`booster_pack_rules.definition_json` 是不可变完整规则快照；`booster_packs.active_rule_version` 仅选择其当前公示版本。MVP 数据模型与规则输入均不包含保底、计数器或跨包状态。
- `BRO-BASE` 与 `SOS-BASE` 分别只从各自系列的 `nonfoil`、`common`/`uncommon`/`rare`/`mythic` Scryfall SKU 生成候选池；卡位固定为 10 张普通、3 张非普通、1 张稀有（有秘稀时按 7:1 选择稀有/秘稀）。每次成功目录同步都追加新版本，不覆盖历史规则或已结算开包记录。
- `@mtg-market/rules` 的 `openPack` 和 `packSlotProbabilities` 只接受版本、整数权重、候选池、卡位和随机种子，返回可重放产出或服务端计算的合计 10,000 bp 稀有度概率。浏览器与 AI 不调用规则来指定或推导产出。
- `PackService.generateAuditedResult` 使用 Node CSPRNG 创建 32-byte 种子，在短事务中将种子、SHA-256、规则版本关联及结果摘要追加到 `pack_rule_replays`；该表没有 HTTP 读取路由，种子也不在 `PackDto` 中出现。

## 商店结算与开包记录（I12B）

- `PackService.openForPurchase` 是唯一的玩家开包命令。它通过 inventory application 的 `withLedgerTransaction` 在一笔短 SQLite 事务内调用 users application 的扣款命令、随机审计、库存入账、`pack_openings`、`pack.opened` 事实事件/outbox、业务审计与幂等响应；任何库存、账本或事件错误都会回滚整笔操作。
- `pack_openings` 只追加玩家、补充包、规则版本、随机重放关联、消费额及脱敏结果摘要。`pack_rule_replays` 原始种子仍没有 HTTP 路由；玩家历史只通过 `/v1/pack-openings` 获得已结算 SKU 和成本。
- 商店只允许活动包、当前规则版本和完整 SKU 引用进入交易。I17B 前结果的参考价、游戏内价和盈亏均为明确的不可用状态，`pack.opened` 只追加保存供后续市场模块消费，绝不在本期提前计算报价。

## 管理后台模块边界（计划 I30B）

- `modules/admin` 只编排管理用例与聚合只读查询，不得跨模块直接读写表。用户冻结/解冻和补偿修正调用 users/inventory 等所属模块的 application 命令；活动发布调用 market/application，并通过任务 application 投递版本唯一的 `market.reprice`。
- 活动采用草稿、已排期、已生效、已暂停、已结束的显式状态与实体版本。预览只返回服务端校验结果；发布、暂停和结束是分别审计且要求幂等键的命令，已发布版本不得原地覆盖。
- 玩家管理 API 只提供完成检索、冻结/解冻、会话撤销和补偿修正所需的最小数据；不返回密码哈希、令牌摘要或通用数据库字段，也不提供直接设置最终余额/库存的接口。
- audit/jobs/narratives 等日志由各模块 application 暴露分页、筛选、脱敏查询端口，admin 负责组合 DTO，不访问对方 infrastructure。日志只读，不提供删除/修改路由。
