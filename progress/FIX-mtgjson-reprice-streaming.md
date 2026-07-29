# FIX MTGJSON 报价刷新与流式下载修复记录

日期：2026-07-29

类型：非迭代修复（数据新鲜度/健壮性），与 I20F 同次变更提交。

## 新增

- `apps/api/src/platform/external/mtgjson/mtgjson-client.test.ts`：MTGJSON 流式适配器回归测试（6 项）。覆盖 gzip 与未压缩两路载荷的 `download`（AllPricesToday + AllPrintings 流式解析、UUID/工艺映射保留、checksum 校验通过）与 `downloadAllPrices`（逐 UUID+工艺保留全部自然日 EUR 正值，原 `0x1fffffe8` 报错入口）；checksum 不匹配抛 `MtgjsonChecksumMismatchError`、`allowChecksumMismatch` 标 `bypassed`；缺失 `cards` 抛错、非 EUR 被跳过。
- `progress/FIX-mtgjson-reprice-streaming.md`：本文件。

## 修改

- `apps/api/package.json`：dependencies 新增 `stream-chain@^4.2.5`、`stream-json@^3.5.0`；devDependencies 新增 `@types/stream-chain@^2.1.0`、`@types/stream-json@^1.7.8`。`pnpm-lock.yaml` 同步更新。
- `apps/api/src/platform/external/mtgjson/mtgjson-client.ts`：整体重写为流式。`streamToFile`：`response.body`（web ReadableStream）→ Node Readable → `pipeline` 同时写 `TMPDIR` 临时文件 + 喂 `createHash("sha256")`（单遍、恒定内存），下载失败/截断最多重试 3 次；`verifyChecksum` 改用下载阶段已算出的 checksum，不做二次全量哈希。`openDecodingStream`：读文件前两字节按 gzip 魔数（`0x1f 0x8b`）决定 `createReadStream → createGunzip` 或直接透传（兼容测试未压缩 JSON fixture）。解析全部改 `chain([openDecodingStream, parser, Pick, StreamObject/StreamValues])`：`readMetaVersion`（Pick "meta"）、`streamPriceDataEntries`（Pick "data" + StreamObject 保留 UUID 属性名）、`collectTodayPrices`/`collectHistoricalPrices`（逐 UUID 提取 EUR cardmarket retail 各工艺价）、`collectAllPrintingsMappings`（Pick `data.<set>.cards` + StreamValues 逐卡映射）。删除原全量 `gunzipSync`+`JSON.parse(buffer.toString("utf8"))`（V8 单字符串上限根因）。`download`/`downloadAllPrices` 对外签名与返回类型不变，application 层零改动；临时文件在 `finally` 删除。
- `apps/api/src/modules/pricing/application/price-sync-service.ts`：投递 reprice 的 triggerKey 从 `` `price-sync:${runId}` `` 改为 `` `price-sync:${completedAt.slice(0, 10)}` ``（下载完成的 UTC 自然日），`priceSyncRunId` 仍传 runId；附注释说明报价新鲜度不再耦合 MTGJSON `meta.date`。
- `apps/api/src/modules/market/application/market-service.ts`：默认 triggerKey fallback 从 `` `price-sync:${runId}` `` 改为 `` `price-sync:${now.slice(0, 10)}` ``（与显式投递路径一致）；`market_quotes` INSERT 的 `ON CONFLICT(sku_id, trigger_key) DO NOTHING` 改为 `DO UPDATE SET`（覆盖 `price_snapshot_entry_id`/`rule_version`/`reference_price_eur_cents`/各 `*_amount`/`parameters_json`/`reasons_json`/`calculated_at`/`valid_until` 全部业务字段）；类注释更新幂等语义为「同日只保留最新业务结果」；`written` 计数注释更新为「落库行数（新增或覆盖）」。
- `apps/api/src/modules/market/application/market-service.test.ts`：幂等测试重写——原 `[0, 1]`（首写 1、重放跳过 0）改为 `[1, 1]`（首写 1、同日重放覆盖 1），`market_quotes` COUNT 仍为 1；新增「同日二次 reprice 覆盖刷新 `calculated_at`/`valid_until`，跨日保留各自版本」测试。
- `apps/api/src/modules/pricing/application/price-sync-service.test.ts`：新增「成功同步后按 UTC 自然日投递 market.reprice，triggerKey 与 job 唯一键均为 `price-sync:YYYY-MM-DD`」断言。
- `apps/api/docs/operations/README.md`：I13B 节更新三个载荷的流式下载/解析说明（临时文件、单遍 SHA-256、重试、gzip 魔数判定、杜绝全量 `toString`）；I14B 节更新 triggerKey 为 `price-sync:YYYY-MM-DD`、补 `DO UPDATE` 同日覆盖语义、`reprice` 返回值语义、15 分钟有效期与 `VERSION_STALE` 预期行为。
- `项目协作文档索引.md`：新增 2026-07-29 修复状态行。

## 删除

- 无。

## 特殊点

- 权威边界不变：MTGJSON 仍是「非权威外部输入」，下载/校验/解析/缓存全部在后端 `mtgjson-client.ts`（infrastructure 适配器）内完成，application 层（price-sync/backfill/market-service）只消费经形状/币种/SHA-256 校验的最小映射/价格输入；失败保留最近成功快照，不删除、不覆盖旧数据。`market-service.reprice` 只读 `price_snapshot_entries` + 已结算 fact_events，写 `market_quotes` 投影；不修改外部快照、库存或流水。
- 契约/迁移：未改 `market_quotes` schema（仍是 `UNIQUE(sku_id, trigger_key)`，迁移 `0016`）、未改 `price_sync_state`/`price_sync_schedule_state` 语义、未改 backfill 的 `source_version` 写法与「不触发 reprice」不变量。triggerKey 改 UTC 日 + DO UPDATE 是写入语义变更，不涉及表结构。`historicalPricesFrom`→`collectHistoricalPrices` 仍聚合成 `Map<string, MtgjsonHistoricalPrice[]>`（backfill 需 byDate 分组，聚合在内存安全——价格条目远小于整个 JSON，触发上限的是「整个 JSON 转字符串」，流式解析后不再发生）。
- 幂等语义变更（重要）：旧「同 triggerKey 重放由 DO NOTHING 跳过（首写优先）」→ 新「同日 triggerKey 由 DO UPDATE 覆盖（同日只保留最新业务结果）」。这是有意为之——让同日二次同步能纠错/续期，且业务结果按 SKU 维度至多一次。`market-service.test.ts` 断言相应更新。backfill 路径不触发 reprice，不受影响。
- 流式背压陷阱：实现过程中尝试过「手写 Transform + `gunzip.on("data")` 动态切换」的 `maybeGunzip`，会因破坏 Node 流背压导致 gzip 载荷测试死锁（超时）；最终改用 `openDecodingStream`：先 `readSync` 文件头两字节判定，再返回 `createReadStream().pipe(createGunzip())` 或 `createReadStream()`，由 Node 原生 pipe 管理背压，gzip/未压缩两路均正确。
- job 恢复：卡住的 `prices.sync` job（`locked_until` 过期）由 `task-runner` 的 `recoverExpired`（在每次 `claim()` 开头执行 + 进程启动 `worker.recover()`）自愈——重置为 pending 重跑。已只读验证：该 job 现为 `succeeded`、关联 `market.reprice` job 亦 `succeeded`。无需手动改 jobs 表，符合「至少执行一次、业务结果至多一次」设计。
- 延后项：dev 环境的端到端重跑（产生 `price-sync:2026-07-29` triggerKey 的真实同步）需重启 dev 进程加载新依赖 + admin 凭据触发，本次未执行；新代码行为已由 110 个 api 测试（含流式等价性、triggerKey 断言、覆盖语义）权威验证。报价 stale 是 15 分钟有效期的正常表现，下次每日同步会用新代码刷新。
- 验证：`pnpm check`（eslint + 6 个 workspace tsc）全过；`pnpm --filter @mtg-market/api test` 110 通过（market-service 7、price-sync 7、price-backfill 7、mtgjson-client 6 新增、order-routes 29、app 10、其余各模块）。
