# I18F：P2P 委托创建与我的订单页面 — 实施计划

后端 I18B 已完成（`OrderService` + 8 个 `/v1/orders/*` 端点 + `packages/rules` 的 `order/v1`）。I18F 只做前端。沿用 I15F/I16F 的 NPC 弹窗模式，确保权威边界、幂等、同步双击锁与缓存失效语义完全一致。

## 入口与导航
- 市场页可交易 SKU 行新增「挂买单」按钮（与「向 NPC 买入」并列）；库存页可用持仓行新增「挂卖单」按钮（与「向 NPC 卖出」并列）。两个按钮各只决定方向，弹窗内仍可切换方向。
- 玩家侧导航 `components/navigation-shell.tsx` 新增 `/orders`（「我的委托」）。

## 新增文件

1. **`apps/web/api/orders-api.ts`** — 唯一前端入口（镜像 `npc-trade-api.ts`）：
   - `bilateralOrderApi`：`buyPreview / sellPreview / createBuy / createSell / list / find / cancel / book`。
   - `useOrderPreviewQuery(skuId, side, quantity, enabled)` → queryKey `["orders","preview",user.id,skuId,side,quantity]`，`refetchOnMount:"always"`、`retry:false`。
   - `useCreateOrderMutation(side)` → 意图元组 `{skuId,quoteId,quoteVersion,previewVersion,quantity,limitPrice}`；任一变化才换 `createIdempotencyKey()`；`onSuccess` 失效 `orders / archive / ledger / inventory / market* / prices.public-status`；返回 `beginNewIntent()`。
   - `useOrdersQuery(filters)` → queryKey `["orders",user.id,filters]`；`useOrderBookQuery(skuId)` → queryKey `["orders","book",user.id,skuId]`。
   - `useCancelOrderMutation()` → 意图 `{orderId}`；`onSuccess` 失效 `orders`、`archive`、`ledger`、`inventory`。
   - `OrdersFilters` 类型：`{status?: OrderStatus; side?: OrderSide; cursor?; limit?}`。

2. **`apps/web/features/orders/create-order-dialog.tsx`** — 统一创建弹窗（核心组件，复用 `npc-sell-dialog` 的同步 `confirmationLock` ref 双击锁）：
   - 入参 `{ sku: {id,name,setCode,collectorNumber}; initialSide; onClose; onSettled(order) }`。
   - 方向切换（买/卖，state，切换时 `beginNewIntent()`+清预览+重拉预览）、数量输入（1..1000 整数校验）、限价输入（整数最小货币单位，默认 `limitBand.marketPrice.amount`，范围提示 `[min,max]`）。
   - 数量/方向变化或手动点「获取服务端预览」→ `useOrderPreviewQuery`，展示服务端 `BilateralOrderPreviewDto`（限价带、`fees`、`reservedFunds`、`estimatedAmount`、`validUntil`、`limit`、卖单 `availableQuantity`、`canPlace`/`unavailableReason`）。
   - `unavailableReason` 中文映射（archive_required / insufficient_balance / insufficient_inventory / trade_limit_reached）。
   - 二次确认按钮：仅当 `previewValue?.canPlace` 且限价落在 `[min,max]`（前端即时校验只作反馈，**真正边界由服务端 `RULE_VIOLATION` 兜底**）才可点；提交只回传 `{quoteId,quoteVersion,previewVersion,quantity,limitPrice}`，绝不回传费用/保证金。
   - 错误映射：`VERSION_STALE`→「报价已过期，请重新预览」+ 自动 `beginNewIntent` 重拉；`INSUFFICIENT_BALANCE/INVENTORY`、`INVENTORY_LOCKED`、`RULE_VIOLATION`、`IDEMPOTENCY_CONFLICT`、`IDEMPOTENCY_IN_PROGRESS` 展示服务端 message 并提供「重新预览」。
   - 载入/空/错状态齐全；遵循 `role="dialog"`/`aria-modal`/`aria-labelledby`。

3. **`apps/web/features/orders/orders-page.tsx`** — 「我的委托」页面（镜像 `inventory-page.tsx`）：
   - antd `Table<BilateralOrderDto>`：方向 Tag、状态 Tag、SKU（id）、原始/剩余数量、`limitPrice`、`fees` 摘要（order_fee/fulfillment_deposit）、`reservedFunds`/`reservedInventoryQuantity`、`expiresAt`、`version`、`createdAt`/`updatedAt`。
   - URL 驱动筛选（status/side/cursor/limit，沿用 `filtersFromSearch`/`toUrl` 模式）；antd `Pagination` + offset cursor。
   - 撤单：仅 `open`/`partially_filled` 行显示「撤单」按钮；点击弹 `ConfirmDialog`（复用 `components/ui.tsx`），确认后调 `useCancelOrderMutation`（携带幂等键），`409 RESOURCE_CONFLICT` 提示「委托状态已变化，请刷新后重试」并自动重查。
   - 撤单成功展示内联 `tradeSuccess` 区块（释放金额来自服务端 `reservedFunds`/`reservedInventoryQuantity`）。
   - 加载 `PageSkeleton`、失败 `ErrorState`、空 `EmptyState`。
   - 说明文案：撮合/履约/到期在 I19B+ 实现，此页只展示服务端订单状态与撤单。

4. **`apps/web/features/orders/orders-page.module.css`** — 复用 `inventory-page.module.css` 同款类名（`tableWrap/pagination/quantityForm/tradePreview/tradeSuccess/tradeError/inlineError/tradeReady/disabledEntry/secondary/loss/profit`）+ 必要扩展。

5. **`apps/web/app/(player)/orders/page.tsx`** — `<Suspense fallback={skeleton}><OrdersPage/></Suspense>`（因 `useSearchParams` 需要 Suspense，照搬 `market/history/page.tsx`）。

6. **测试**：
   - `apps/web/tests/e2e/orders.spec.ts` — mock `/v1/orders/*`（复用 `npc-sell.spec.ts` 的 `envelope/failure/recoverPlayerSession` 模式）：买单成功+双击只 1 POST、卖单成功、`VERSION_STALE` 重预览换幂等键、`INSUFFICIENT_*`/`RULE_VIOLATION` 禁用确认、撤单成功+`RESOURCE_CONFLICT` 重试、我的委托列表筛选/分页、订单簿只读、窄屏 390×844 不阻断。
   - `apps/web/tests/manual/I18F.md` — 照 `I16F.md` 格式，FE-M05 场景记录买/卖单、预览过期、重复确认/撤单。

## 修改文件
- **`apps/web/features/market/market-page.tsx`**：可交易行加「挂买单」按钮 → 打开 `CreateOrderDialog`（`initialSide:"buy"`）；`completedOrder` 状态展示成交。
- **`apps/web/features/market/market-page.module.css`**：按需补按钮间距。
- **`apps/web/features/inventory/inventory-page.tsx`**：`availableQuantity>0 && sku.tradable` 行加「挂卖单」按钮 → 打开 `CreateOrderDialog`（`initialSide:"sell"`）。
- **`apps/web/features/inventory/inventory-page.module.css`**：同上。
- **`apps/web/components/navigation-shell.tsx`**：玩家 `links` 加 `{href:"/orders",label:"我的委托"}`。
- **`apps/web/ARCHITECTURE.md`**：新增「I18F 委托创建与我的订单页面」段落，记录 query key、幂等意图元组（含 `previewVersion`+`limitPrice`）、同步双击锁、缓存失效范围与延后项。
- **`前端需求.md`**：在 FE-ORDERS 段记录 I18F 页面流程、错误语义、缓存失效与验收资产。
- **`完整项目迭代实施计划与检查清单.md`**：勾选 I18F 四项（实现/Playwright/人工/验收），推进下一可执行轨道（I19B）。
- **`模拟器主流程与核心验收.md`**：更新 AT-05A 浏览器路径执行证据。
- **`项目协作文档索引.md`**：协作基线推进到 I18F 完成、下一轨道 I19B。
- **`apps/api/ARCHITECTURE.md`、`apps/api/docs/api/README.md`**：仅补充「I18F 前端消费」一句话，不改契约/端点（后端无变更）。

## 关键约束（严格遵守）
- **权威边界**：浏览器只提交 `{quoteId,quoteVersion,previewVersion,quantity,limitPrice}`；`previewVersion` 必须 64 位 hex 原样回传；`limitPrice` 为整数最小货币单位；费用/保证金/限价带/可用量全部只展示服务端 DTO，绝不回传或本地重算。
- **幂等**：同一 `(skuId,quoteId,quoteVersion,previewVersion,quantity,limitPrice)` 网络重试复用同一键；任何输入变化（含重新预览带来的新 `previewVersion`）才换键。
- **同步双击锁**：`useRef(false)` 在 `mutate` 前置位，防止 React `disabled` 渲染前的同一事件循环第二击发出第二个 HTTP 请求（照搬 `npc-sell-dialog`）。
- **缓存失效**：成功仅失效服务器真相缓存，不写 Zustand 或本地副本。
- **`VERSION_STALE`**：报价/预览过期必须重新预览，不能用旧 `previewVersion` 重试。
- **延后项**：撮合、模拟履约、`p2p.trade.settled`、`order.expire` 延后 I19B/I20B/I22B；本迭代订单只 `open`，页面不展示撮合/履约 UI。
- **DTO**：全部从 `@mtg-market/contracts` 导入，不重定义。

## 验证
- `pnpm --filter @mtg-market/web check`（eslint + tsc --noEmit）。
- `pnpm --filter @mtg-market/web exec playwright test tests/e2e/orders.spec.ts --workers=2`（桌面+窄屏）。
- 写 `tests/manual/I18F.md` 人工验收记录。
- 全 workspace `pnpm check` 确认未破坏其它包。