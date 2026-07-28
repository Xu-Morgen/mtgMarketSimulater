# I20B 实施计划：P2P 模拟履约保证金、完成与取消后端

## 目标
完成 P2P 成交后的履约状态机，使 AT-06 通过：
- **确认履约**（fulfill）：单短事务扣买方待履约资金、库存转买方、结算卖方收入（已扣 order_fee）、返还卖方保证金、追加 `p2p.trade.settled` 事实事件与重定价 outbox/job，契约返回履约类型与审计关联；不引入实体物流状态。
- **取消履约**（cancel）：扣卖方已冻结保证金、恢复卖方库存、退回买方资金、写完整审计；不产生 `p2p.trade.settled`。
- **到期处理任务**（order.expire）：`runAfter=deadline` 投递，到期把 `open/partially_filled` 委托转 `expired`、把 `matched_pending_fulfillment` 成交转取消；重复状态迁移由状态机条件 UPDATE 防护。

## 关键设计决策（已确认）
1. **履约期限复用 `ttl_seconds`**：撮合成交时 `fulfillment_deadline = 成交时刻 + ttl_seconds*1000`，写入 `bilateral_trades.fulfillment_deadline`（迁移加列）。
2. **order.expire 投递式触发**：创建委托时投递 `uniqueKey=order-expire:{orderId}`、`runAfter=expires_at` 的 `order.expire`；撮合成交时投递 `uniqueKey=trade-expire:{tradeId}`、`runAfter=fulfillment_deadline` 的 `order.expire`。重复投递由 jobs.unique_key 去重；handler 内以状态机条件 UPDATE 兜底（已 fulfilled/cancelled 的实体不再迁移）。

## 履约/取消的资金/库存规则（整数最小货币单位）

撮合后处于 `matched_pending_fulfillment` 的 trade 状态（I19B 已写入）：
- 买方：`order_fulfillment` 资金 hold = `quantity*executionPrice + buyerFee`（关联 trade）。
- 卖方：库存已 `capturePartial` 离开持有（quantity/locked 各减 tradeQuantity）；`order_fulfillment_deposit` 资金 hold = `quantity*unitDeposit`（关联 trade，`unitDeposit = sellerCapturedDeposit/quantity`）。

### 确认履约（fulfill）—— `POST /v1/orders/trades/{tradeId}/fulfill`
单 `withLedgerTransaction` 内：
1. 幂等：`idempotency_requests`（actor=买方或卖方 userId）。请求体为空，fingerprint 仅依赖 path。
2. 校验 trade 存在、请求者是 buyer 或 seller、status=`matched_pending_fulfillment`。
3. **买方资金**：`captureFunds`（release+debit 全量，总额下降）于 `buyerFundsHoldId`，写 `debit` 账本 reason=`p2p_buy`。
4. **卖方保证金返还**：`releaseFunds`（保证金回 available）于 `sellerDepositHoldId`。
5. **卖方收入**：`creditAvailableFunds(quantity*executionPrice - sellerFee, reason="p2p_sell")`。注意：撮合时未预占 order_fee；这里从收入中扣。若 `quantity*executionPrice - sellerFee < 0`（理论上因 fee=marketPrice*bps < price 不会发生，但代码做 `Math.max(0,...)` 保护），扣到 0 不报错。
6. **买方库存**：`acquireInLedgerTransaction(quantity, unitCost=executionPrice, reason="p2p_buy")`。
7. trade.status → `fulfilled`（条件 `WHERE id=? AND status='matched_pending_fulfillment'`）。
8. **p2p.trade.settled 事实事件**：payload 形如 NPC trade（`{tradeId, skuId, side:"p2p", quantity, executionPrice, ...}`，含 `liquidity` 维度的 `{skuId, quantity}`），写 `fact_events` + `outbox('market.fact-event')` + `enqueueMarketRepriceJob('fact-event:'+eventId)`，复用 NPC 的三件套写法。注意 `market-service.ts:312-313` 按 `liquidity` 消费一次 `quantity`，故只写一条事件（不区分买/卖侧）。
9. 双方各一条 `bilateral_trade.fulfilled` 审计（关联 tradeId、holdId、executionPrice、费用、规则版本）。
10. 完成幂等响应 `{ trade, balance }`（`balance` 用买方视角，与 NPC buy 响应一致便于前端复用）。
11. 取消该 trade 的到期 job：不删 job（jobs 表无 cancel 接口），由 handler 兜底（status 已是 fulfilled 则跳过）。

### 取消履约（cancel）—— `POST /v1/orders/trades/{tradeId}/cancel`
单事务内：
1. 幂等同上。
2. 校验 status=`matched_pending_fulfillment`、请求者是 buyer 或 seller。
3. **买方资金退回**：`releaseFunds`（资金回 available）于 `buyerFundsHoldId`。
4. **卖方保证金扣除**：`captureFunds`（debit 保证金，总额下降）于 `sellerDepositHoldId`，写 `debit` 账本 reason=`p2p_deposit_forfeited`。
5. **卖方库存恢复**：新增 `restorePartialInLedgerTransaction({userId, skuId, quantity, correlationId, now})` —— 把 tradeQuantity 加回卖方 holding 的 quantity/available（不走 hold，因为该 trade 的 inventory hold 已在撮合时被 capturePartial 收缩/捕获）。直接 `UPDATE inventory_holdings SET quantity+=, available_quantity+=` 并写 `inventory_entries` reason=`order_restored`。
6. trade.status → `cancelled`（条件 UPDATE）。
7. **不写 p2p.trade.settled**；写买卖各一条 `bilateral_trade.cancelled` 审计。
8. 完成幂等响应 `{ trade, balance }`。

### order.expire handler —— `task-runner.ts` 注册
handler payload `{kind:"order"|"trade", id}`：
- `kind=order`：`open/partially_filled` 且 `expires_at<=now` → 释放剩余资金/库存/保证金预占（复用现有撤单释放路径），status → `expired`，条件 UPDATE。已 cancelled/fulfilled/expired 跳过。
- `kind=trade`：`matched_pending_fulfillment` 且 `fulfillment_deadline<=now` → 走「取消履约」逻辑（同事务），并把 trade.status → `cancelled`、写审计。已 fulfilled/cancelled 跳过。
- 失败由 TaskWorker 重试（最多 maxAttempts，指数退避）；每次只处理一个 id，幂等由状态机保证。

## 文件改动清单

### 迁移（新增 1 个）
- `packages/database/migrations/0021_p2p_fulfillment.sql`：给 `bilateral_trades` 加 `fulfillment_deadline TEXT NOT NULL DEFAULT '9999-12-31T23:59:59.999Z'`（旧行占位，新撮合写入真实 deadline）；加索引 `bilateral_trades_status_fulfillment_deadline_index(status, fulfillment_deadline)` 便于扫描/排障。

### packages/contracts/src/index.ts（修改）
- 扩展 `BilateralTradeDto` 与 `PlayerBilateralTradeDto`：新增 `fulfillmentDeadline: string`（取自 trade.fulfillment_deadline）。保留 `BilateralTradeStatus` 现有三值。
- 新增 `fulfillmentType` 常量说明（注释：本期单一 `simulated`，不引入实体物流状态）。

### packages/contracts/src/index.test.ts（修改）
- 新增断言：`BilateralTradeDto`/`PlayerBilateralTradeDto` 含 `fulfillmentDeadline`，且 status 集合覆盖 fulfilled/cancelled。

### packages/rules/src/index.ts（修改）
- 新增 `order-fulfillment/v1`：`ORDER_FULFILLMENT_RULE_VERSION`、`resolveFulfillmentDeadline(ttlSeconds, matchedAt)`（返回 ISO8601）、`validateTradeFulfillment(status)`（返回显式 ok/{reason}）、`validateTradeCancellation(status)`。纯函数、显式校验。成交价、收入与保证金计算的服务端语义都从 trade 字段读，规则只负责状态校验与 deadline 派生（避免把经济算法重复散落在多处）。

### packages/rules/src/index.test.ts（修改）
- 新增 `I20B 履约规则` 测试组：deadline 派生与边界、status 校验、未知版本拒绝、确定性。

### apps/api/src/modules/orders/domain/order.ts（修改）
- 新增常量：`ORDER_FULFILLMENT_FUND_HOLD_REASON`（已有）、`P2P_TRADE_ENTITY_TYPE="bilateral_trade"`、`P2P_SELL_DEPOSIT_RESTORE` 等；新增 `FULFILLABLE_TRADE_STATUSES`、`isFulfillableTrade`、`isCancellableTrade`、`ORDER_EXPIRE_TASK_PREFIX` 等。
- 状态机注释更新：`matched_pending_fulfillment → fulfilled|cancelled`。

### apps/api/src/modules/inventory/application/inventory-service.ts（修改）
- 新增 `restorePartialInLedgerTransaction({userId, skuId, quantity, correlationId, now})`，调用 `SqliteInventoryRepository.restorePartial`。

### apps/api/src/modules/inventory/infrastructure/sqlite-inventory-repository.ts（修改）
- 新增 `restorePartial(userId, skuId, quantity, correlationId, now)`：`quantity+=, available_quantity+=`，写 `inventory_entries` reason=`order_restored`。仅用于取消履约恢复已 capture 的库存。

### apps/api/src/modules/orders/application/order-service.ts（修改 — 核心）
- 新增 `fulfill(input)`、`cancelTrade(input)`（取消履约，区别于现有 `cancel` 撤单）、`expireOrder(input)`、`expireTrade(input)`（供 order.expire handler 调用）、`listAdminTrades`（如需，本期可不加 admin 列表，由 listPlayerTrades 满足）。
- 新增辅助：`loadTradeRow`（含 fulfillment_deadline/holdIds）、`applyFulfillment`、`applyTradeCancellation`、`writeP2pTradeSettledEvent`、`toTradeDto`/`toPlayerTradeDto` 加 fulfillmentDeadline。
- `applyLeg`（撮合）：在写 `bilateral_trades` 后计算 `fulfillmentDeadline` 入列；**撮合成功后投递 `order.expire`（kind=trade, runAfter=deadline, uniqueKey=trade-expire:{tradeId}）**。
- `create`（建单）：创建委托成功后投递 `order.expire`（kind=order, runAfter=expires_at, uniqueKey=order-expire:{orderId}）。

### apps/api/src/modules/orders/api/order-routes.ts（修改）
- 新增 `POST /v1/orders/trades/{tradeId}/fulfill`（player，需 Idempotency-Key，body 空）。
- 新增 `POST /v1/orders/trades/{tradeId}/cancel`（player，需 Idempotency-Key，body 空）。
- 新增 `POST /v1/orders/trades/{tradeId}/expire`（admin，body 空，运维/测试显式到期；幂等）。
- 复用 `resolveCommand`、`orderCancelRequestFingerprint`（按 body+path 计算 fingerprint）。

### apps/api/src/modules/orders/api/order-routes.test.ts（修改）
- 新增 `I20B 履约与取消` 测试组（覆盖 AT-06）：
  - 正常履约：买方资金扣除+库存增加、卖方收入到账+保证金返还、`p2p.trade.settled` 写入且 outbox/reprice job 投递、双方审计、trade.status=fulfilled、账本可查。
  - 取消履约：买方资金退回、卖方库存恢复+保证金扣除、**不写 `p2p.trade.settled`**、双方审计、trade.status=cancelled。
  - 幂等重放（fulfill/cancel 同键返回首次结果）、同键异参 conflict、状态机防护（已 fulfilled 再 fulfill 返回 RESOURCE_CONFLICT、已 cancelled 再 cancel 冲突）。
  - 无关玩家不可履约/取消他人 trade（404）、未成交 trade 不可履约（409）。
  - 部分撮合后只对已成交 trade 履约；卖单委托仍 partially_filled 不受影响。
  - order.expire：到期 open 委托转 expired 并释放预占；到期 trade 转取消并恢复资产；已 fulfilled/cancelled 不重复迁移；并发/重跑不重复。
  - 事务回滚：注入触发器强制 `bilateral_trades` 更新失败，验证无半完成状态、资金/库存/保证金守恒。

### apps/api/src/task-runner.ts（修改）
- 在 `createTaskRegistry` 新增 `registry.register("order.expire", async (payload) => orderService.expireByPayload(payload))`。注入 OrderService 实例（已在 task-runner 现有依赖范围）。

### apps/api/src/modules/jobs/task-worker.test.ts（修改 — 可选）
- 若 order.expire handler 注册改变 TaskRegistry 默认行为，补一行断言：order.expire 已注册非空 handler。

### apps/api/src/openapi.ts（修改）
- `publicApiPaths` 与 `paths` 登记 `POST /v1/orders/trades/{tradeId}/fulfill`、`/cancel`、`/expire`。

### apps/api/ARCHITECTURE.md、apps/api/docs/api/README.md、apps/api/docs/operations/README.md、后端需求.md（修改）
- 新增 I20B 履约/取消/到期协议、状态机、排障与「禁止直接修数」原则；更新延后项（履约/取消/`p2p.trade.settled` 已上线；`order.expire` 完整到期回收在 I22B 增强端到端恢复用例）。

### packages/database/src/index.test.ts（修改）
- 迁移计数期望 20→21；可选追加 `bilateral_trades.fulfillment_deadline` 列存在断言。

### 完整项目迭代实施计划与检查清单.md、模拟器主流程与核心验收.md、项目协作文档索引.md（修改）
- 勾选 I20B 全部 4 项；更新状态行（下一轨道 I20F）；AT-06 后端证据行。

### progress/I20B.md（新增）
- 按「新增/修改/删除/特殊点」记录本迭代文件事实与权威边界、契约迁移、幂等审计、事务回滚、延后项、验证结果。

## 不在 I20B 范围（延后）
- I20F 履约/取消/到期的浏览器页面与 Playwright/人工验收。
- I21B 风控（价格边界/频率/自成交标记）。
- I22B 端到端一致性恢复测试集与运营手册（order.expire 已可工作，但全链路恢复回归属 I22B）。

## 验证
- `pnpm --filter @mtg-market/rules test`（新增履约规则单测）
- `pnpm --filter @mtg-market/contracts test`
- `pnpm --filter @mtg-market/database test`（迁移计数 21）
- `pnpm --filter @mtg-market/api test`（order-routes 新增履约/取消/到期集成测试，含并发、幂等、回滚）
- 全 workspace `pnpm check`（eslint + tsc --noEmit）

## 权威边界自检
- 履约/取消只在 `withLedgerTransaction` 内经 users/inventory application 接口协作，不跨界写 accounts/fund_holds/inventory 表。
- `p2p.trade.settled` 走 `fact_events`+`outbox`+`enqueueMarketRepriceJob`，市场只消费已结算事实。
- 状态迁移用条件 UPDATE（`WHERE status='matched_pending_fulfillment'` 等），并发与重跑至多一次业务结果。
- 不删除/不直接覆盖流水；所有资金/库存/保证金变动都伴随账本 entry 或审计。