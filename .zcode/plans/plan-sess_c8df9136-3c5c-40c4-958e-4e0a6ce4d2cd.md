# I17F 实施计划：价格历史与市场曲线页面

## 目标
让价格数据可理解、可切换时间范围（7d/30d/all），并在同步失败时明确降级为旧价而非空白。满足 I17F checklist 四项与 AT-03B 浏览器部分。

## 设计决策
- **页面位置**：新建玩家导航路由 `/market/history`，集中展示市场指数双曲线、单卡搜索筛选 + 双曲线、数据来源/过期状态、空数据降级表格。`/market` 保持报价列表 + NPC 交易入口，新增一个"查看价格历史"链接。职责清晰，与既有 buy 流理解耦。
- **图表库**：新增 `echarts` 依赖（checklist 与技术栈 §2 明确要求 ECharts；目前未安装）。不引入 framer-motion（本页不需要动画）。
- **数据边界**：页面只读本地 Fastify 已物化的 `/v1/market/quotes/:skuId/history`、`/v1/market/index/history`、`/v1/market/quotes`（搜索候选）与 `/v1/prices/status`；不在浏览器推导价格、插值或汇率。
- **状态规则**：TanStack Query 按用户 + skuId/skuQuery/range 隔离；range 写入 URL（默认 30d），刷新可恢复。无 mutation，无需幂等键。

## 文件变更

### 新增
1. **`apps/web/components/market/price-history-chart.tsx`** — 客户端 ECharts 双折线组件。接收 `PriceHistoryPointDto[]` / `MarketIndexHistoryPointDto[]` 与两条货币轴标签（EUR 参考价 vs GAME_CREDIT 游戏内价）。null 点用 `connectNulls: false` 明确断开，不插值。canvas 渲染，固定高度，`role="img"` + 中文 `aria-label` 摘要；颜色区分两条线（参考价灰/橙、游戏内价蓝/绿），图例含来源说明。
2. **`apps/web/components/market/index.module.css`** — 图表容器与降级表格样式（窄屏可读）。
3. **`apps/web/features/market/price-history-page.tsx`** — 页面编排。两个区块：①市场指数双曲线（默认 30d，可切换 7d/30d/all，失败降级为只读表格）；②单卡搜索（名称/系列/稀有度/工艺 → `/v1/market/quotes?limit=20` 分页候选列表）→ 选中 SKU 后展示该卡 `history` 双曲线。展示 `PublicPriceStatusDto` 来源/更新时间/过期状态与固定 disclaimer。空 points 显示"该 SKU/范围暂无历史快照"而非空白。失败时显示错误重试，不伪造价格。
4. **`apps/web/app/(player)/market/history/page.tsx`** — App Router 入口，仅组合 `PriceHistoryPage`，承载 Suspense（`useSearchParams` 需客户端边界）与 loading。
5. **`apps/web/tests/e2e/price-history.spec.ts`** — Playwright（桌面 + 390×844 窄屏）。路由桩覆盖：①切换 7d/30d/all 触发对应 query 且 URL 同步；②单卡有历史渲染图表区与日期/数值标签、空历史显示降级文案；③`prices.sync` 失败（freshness=stale）仍展示旧价与"沿用旧快照"状态而非空白；④图表区键盘可达（Tab + aria-label 可读）+ 窄屏不阻断。
6. **`apps/web/tests/manual/I17F.md`** — 人工验收记录（FE-MARKET / FE-CATALOG I17F 关联），含构建标识、视口、测试账号/SKU、步骤、预期/实际、结果。

### 修改
7. **`apps/web/api/market-api.ts`** — 新增 `history(accessToken, skuId, range)`、`indexHistory(accessToken, range)` 客户端与 `usePriceHistoryQuery(skuId, range)`、`useMarketIndexHistoryQuery(range)` hook（queryKey 含 userId + skuId/range；retry: false；enabled 依赖登录与 skuId/range 有效）。注意 `indexHistory` 顶部已存在 `MarketIndexDto` 类型常量，新增不冲突。
8. **`apps/web/features/market/market-page.tsx`** — 顶部摘要区或筛选栏旁加一个 `Link` "查看价格历史" → `/market/history`。
9. **`apps/web/package.json`** — 新增 `echarts` 依赖（匹配技术栈 §2 推荐版本，使用 `^5` 稳定线）。
10. **`apps/web/ARCHITECTURE.md`** — 新增 "I17F 价格历史与市场曲线页面" 段：数据入口、URL range 状态、双货币轴、降级表格、查询键隔离、空/失败态。
11. **`前端需求.md`** — 新增 "2.7 I17F 价格历史与市场曲线（已完成）" 段；FE-MARKET 行补充价格历史能力（如未覆盖）。
12. **`完整项目迭代实施计划与检查清单.md`** — 勾选 I17F 四项 checklist；更新状态行（下一可执行轨道改为 I18B）。
13. **`模拟器主流程与核心验收.md`** — AT-03B 浏览器部分补 I17F 证据行。
14. **`项目协作文档索引.md`** — 当前协作基线追加 I17F 段，链接 `progress/I17F.md`。

### progress
15. **`progress/I17F.md`** — 新建/总结文件（按 AGENTS.md §8 规范：新增/修改/删除分类 + 特殊点）。

## 关键约束（来自 AGENTS.md 与既有边界）
- 浏览器只展示服务端返回的价格、来源、更新时间、过期状态与 disclaimer；不推导/插值/汇率。
- `range` 限定 `7d|30d|all`，默认 `30d`；切换写入 URL，刷新可恢复。
- 图表 null 点断线，不掩盖空态；失败降级为表格或重试，不伪造实时价。
- DTO 全部来自 `@mtg-market/contracts`，不重定义。
- 不修改后端、规则或迁移（I17B 已提供所需端点与 DTO）。

## 验证
- `pnpm --filter @mtg-market/web check`（tsc --noEmit）。
- `pnpm --filter @mtg-market/web test:e2e -- price-history`（路由桩，桌面 + 窄屏）。
- 人工执行 `tests/manual/I17F.md` 的 FE-MARKET/FE-CATALOG 步骤。
- `pnpm check`（全 workspace tsc）。

## 不做的事
- 不引入 framer-motion（本页无动画需求）。
- 不改 `/v1/market/*` 后端、规则或迁移。
- 不在浏览器缓存/重算历史、不做客户端插值或滚动平均。
- 不提前实现 I18B（P2P 委托）相关内容。