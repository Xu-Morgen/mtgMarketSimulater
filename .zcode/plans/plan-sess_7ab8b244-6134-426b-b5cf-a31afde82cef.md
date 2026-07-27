# I17B 实现计划：价格历史、市场查询与每日同步后端

## 核心设计判断

探索确认 `price_snapshot_entries`(UNIQUE(sync_run_id, sku_id))和 `market_quotes`(UNIQUE(sku_id, trigger_key))**已经是只追加的**,每次每日同步/重定价都生成新行——**价格历史事实上已经隐式保留**。因此 I17B 主要是补齐:(1) 时间范围查询能力;(2) 每日同步调度与启动补跑;(3) AllPrices 历史回填;(4) 数据源说明。**不为历史另建存储表**,避免与既有 append-only 设计重复漂移。

---

## 一、数据库迁移 `packages/database/migrations/0018_price_history_and_schedule.sql`

```sql
-- 1) 区分日常同步与一次性历史回填运行（NOT NULL DEFAULT 保证旧行兼容）
ALTER TABLE price_sync_runs ADD COLUMN run_kind TEXT NOT NULL DEFAULT 'daily'
  CHECK (run_kind IN ('daily', 'backfill'));

-- 2) 每日同步进度单例；与 price_sync_state（最近成功指针）解耦，
--    补跑/重跑以自然日唯一键收敛，不重复发钱、不重复刷新。
CREATE TABLE IF NOT EXISTS price_sync_schedule_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  last_scheduled_date TEXT NOT NULL,        -- 已为该 UTC 自然日投递过 prices.sync 的日期 YYYY-MM-DD
  last_attempted_run_after TEXT NOT NULL,   -- 最近一次投递的 run_after ISO 时间，用于审计
  updated_at TEXT NOT NULL
);
INSERT INTO price_sync_schedule_state (singleton, last_scheduled_date, last_attempted_run_after, updated_at)
VALUES (1, '1970-01-01', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')
ON CONFLICT(singleton) DO NOTHING;
```

同步在 `packages/database/src/schema.ts` 给 `priceSyncRuns` 补 `runKind` 列,并新增 `priceSyncScheduleState` 表(同时补齐此前 5 张 market 表缺失的 Drizzle 定义是另一处漂移,但**不在本次范围**,仅记录在 progress 特殊点)。

## 二、contracts `packages/contracts/src/index.ts`(版本号不变,日期已是 2026-07-27)

新增 DTO:
- `PriceHistoryRange = "7d" | "30d" | "all"`(查询参数字面量)
- `PriceHistoryPointDto = { date: string; referencePrice: Money | null; marketPrice: Money | null }`(按天采样:每 SKU 每自然日一个点)
- `PriceHistoryDto = { skuId: string; range: PriceHistoryRange; points: PriceHistoryPointDto[]; referenceSource: "mtgjson-cardmarket" | null; generatedAt: string }`
- `MarketIndexHistoryPointDto = { date: string; referenceIndex: number | null; gameIndex: number | null }`
- `MarketIndexHistoryDto = { range: PriceHistoryRange; points: MarketIndexHistoryPointDto[]; generatedAt: string }`
- 扩展 `PriceSyncRunDto`:新增 `runKind: "daily" | "backfill"`(默认 daily,旧记录兼容)
- `PriceSyncBackfillResultDto`:回填运行的统计(已插入/跳过/无价/映射失败/日期范围/版本/checksum)

## 三、每日同步调度(用户选定:task-runner 内嵌日切轮询)

`apps/api/src/modules/jobs/application/task-service.ts`:
- 新增导出 `ensureDailyPriceSyncScheduled(database, today, now)`:在事务内 `SELECT last_scheduled_date`,若 `< today` 则 `INSERT ... ON CONFLICT(type, unique_key) DO NOTHING` 投递 `prices.sync`(uniqueKey=`prices.sync:daily:<date>`),并 `UPDATE price_sync_schedule_state`。**用唯一键 + 条件 UPDATE 保证至多一次**。

`apps/api/src/task-runner.ts` `startTaskRunner`:
- tick 内在 `runOne()` 之前以独立 `lastDailyCheck` 时间戳节流(每 ~5 分钟检查一次日切,而非每秒),调用 `ensureDailyPriceSyncScheduled(nowUtc, fullIso)`。
- **daily.rollover 的发钱/赛事刷新按验收 AT-10B 明确延后到 I23B/I25B**,本轮只接 prices.sync;在 progress 特殊点记录此边界。
- `createTaskRegistry` 注册 `prices.backfill` 处理器(预注册类型已含 `prices.sync`,但 backfill 是新类型——见下)。

## 四、新增任务类型 `prices.backfill`

`apps/api/src/modules/jobs/domain/job.ts` `registeredJobTypes` 增加 `"prices.backfill"`(放在 `prices.sync` 之后)。

`apps/api/src/modules/pricing/application/price-backfill-service.ts`(新增):
- `backfill(payload, context)`:下载独立 `AllPrices` 端点 → SHA-256 校验(支持 expected checksum 与 `allowChecksumMismatch` 覆写,复用既有 `MtgjsonChecksumMismatchError` 语义)→ 流式解析 → 以 SKU 的当前 `price_sku_mappings`(取每 SKU 最新成功映射)为准,对每个 `(sku_id, date)` 只 INSERT 缺失的 `price_snapshot_entries`(`run_kind='backfill'`),已存在日期跳过。
- 在单事务内写回填运行记录(`price_sync_runs` run_kind='backfill',status='succeeded/failed')+ 统计 + 审计摘要;**绝不更新 `price_sync_state`(日常同步指针)和 `price_sync_schedule_state`**,也**不为每个历史日期投递 `market.reprice`**。
- 失败抛错让 jobs 重试;事务保证不留半批次。

`apps/api/src/platform/external/mtgjson/mtgjson-client.ts`:
- 新增 `downloadAllPrices(options)`:下载并 SHA-256 校验 `AllPrices` 文件,流式提取 `(uuid, finish, date, amount)` 的历史 EUR retail 正值序列(复用现有 `latestPrice` 思路但保留全部日期)。`MtgjsonChecksumFile` 联合类型增加 `"AllPrices"`。

`apps/api/src/config/environment.ts`:
- 新增 `MTGJSON_ALLPRICES_ENDPOINT`(默认 `https://mtgjson.com/api/v5/AllPrices.json.gz`)。

`apps/api/src/modules/pricing/api/pricing-routes.ts`:
- 新增 `POST /v1/admin/prices/backfill`(admin + Idempotency-Key):投递 `prices.backfill` 任务,uniqueKey=`prices.backfill:<idempotencyKey>`;审计 `price_backfill.requested`。
- 新增 `GET /v1/admin/prices/backfill`(admin):返回最近一次回填运行 `PriceSyncBackfillResultDto` + currentJob。
- 复用 `checksumBypassAvailable` 思路(可选 expected checksum)。

## 五、价格/市场历史查询(用户选定:按天采样)

`apps/api/src/modules/market/application/market-service.ts`:
- `history(skuId, range)`:对 `price_snapshot_entries`(reference)与 `market_quotes`(game)按 `captured_at`/`calculated_at` 的**自然日**分组,取该日最新成功运行值;range 转 `since` 截止时间(7d/30d/all)。SQL 用 `substr(captured_at, 1, 10)` 取日期 + DISTINCT。返回 `PriceHistoryDto`。
- `indexHistory(range)`:同样按日聚合 `AVG(reference_price_eur_cents)`、`AVG(market_price_amount)`,返回 `MarketIndexHistoryDto`。

`apps/api/src/modules/market/api/market-routes.ts`:
- `GET /v1/market/quotes/:skuId/history?range=7d|30d|all`(player)
- `GET /v1/market/index/history?range=7d|30d|all`(player)
- 空历史返回空 points 数组(非 404),保证失败同步仍展示旧价/空态。

## 六、数据源说明(检查清单第4条)

- `apps/api/src/modules/pricing/api/pricing-routes.ts` `publicStatus()` 与 `PublicPriceStatusDto`:DTO 增加可选 `disclaimer?: string`(服务端固定文案"价格来自 MTGJSON / Cardmarket EUR 参考快照,游戏内价为虚拟货币 GAME_CREDIT,非实时、非真实资产"),不暴露版本/checksum/任务。
- `apps/web/components/price-status.tsx` 与 `market-page.tsx`:展示该 disclaimer 文案(I17F 会做图表,本轮只补文案 + 历史查询数据可用)。

## 七、测试(Vitest + 临时 SQLite,沿用 `fixture()` 模式)

`apps/api/src/modules/pricing/application/price-backfill-service.test.ts`(新增,版本固定夹具):
- 首次回填、同版本重放(幂等不重复)、已有日期跳过、价格/映射缺失、checksum/解析失败、事务中断(不留半批次)、不移动 `price_sync_state`/`price_sync_schedule_state` 指针、不为历史日投递 market.reprice。

`apps/api/src/modules/market/application/market-service.test.ts`(扩展):
- `history()`/`indexHistory()` 覆盖 7d/30d/all、空历史、跨多日采样、同日多次同步取最新、缺失 reference 或 market 价。

`apps/api/src/task-runner.test.ts`(新增或扩展):
- `ensureDailyPriceSyncScheduled` 日切幂等(同日不重复投递、跨日补投)、重启补跑语义。

`apps/api/src/modules/pricing/api/pricing-routes.test.ts`(扩展,若有;否则在 app.test.ts):
- backfill 端点权限、幂等键、覆写前置条件。

## 八、文档同步(同一变更内)

- `后端需求.md` I17B 节:从"计划"改为"已完成"实现细节(每日调度、backfill 任务、历史查询、数据源说明)。
- `apps/api/docs/api/README.md`:新增 I17B 历史查询与 backfill 协议、扩展 PriceSyncRunDto.runKind。
- `apps/api/docs/operations/README.md` I17B 节:从"计划"改为运维手册(AllPrices 端点、日切轮询、回填排障、不手工写历史)。
- `apps/api/ARCHITECTURE.md`:补 I17B 段(历史隐式 append-only、调度器、backfill 边界)。
- `apps/api/src/openapi.ts`:登记 `/v1/market/quotes/{skuId}/history`、`/v1/market/index/history`、`/v1/admin/prices/backfill`(GET/POST)。
- `完整项目迭代实施计划与检查清单.md`:勾选 I17B 全部 6 项;更新文档索引状态行。
- `项目协作文档索引.md`、`模拟器主流程与核心验收.md`:记录 AT-03B/AT-10A 后端部分通过证据。
- `progress/I17B.md`:按"新增/修改/删除 + 特殊点"格式记录。

## 九、关键边界(写入 progress 特殊点)

1. **权威边界**:历史查询只读 append-only 表;回填不写 `price_sync_state`/`price_sync_schedule_state`,不为历史日投递 `market.reprice`;调度器只投递任务,不直接写经济真相。
2. **幂等**:回填以 `(sku_id, date)` 唯一约束 + `(type, unique_key)` 任务唯一键收敛;日切以 `last_scheduled_date` + `prices.sync:daily:<date>` 唯一键收敛;失败留 failed 运行,不替换旧数据。
3. **事务**:回填与每日同步各在一笔短事务内完成;事务中断不留半批次。
4. **数据源说明**:MTGJSON/Cardmarket 参考价 + 虚拟货币 GAME_CREDIT + 非实时/非真实资产,服务端固定文案,前端不自行拼接。
5. **延后项**:daily.rollover 的发钱/赛事刷新(AT-10B)按验收延后至 I23B/I25B,本轮只接 prices.sync 调度;前端双曲线/图表为 I17F。

## 验证

- `pnpm --filter @mtg-market/api test`(新增与扩展测试)
- `pnpm --filter @mtg-market/database test`(迁移)
- `pnpm --filter @mtg-market/contracts test`(DTO)
- 全 workspace `pnpm check`(类型/lint/构建)