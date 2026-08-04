# FIX 全站视觉重构：暗色奇幻·卡牌交易所

日期：2026-08-04（v1 换肤）；2026-08-04（v2 布局大改）

类型：非迭代 UI 皮肤重构（纯前端样式层），改动清单与约束见 [docs/visual-redesign-checklist.md](../docs/visual-redesign-checklist.md)。

> v2（同日）：在 v1 换肤基础上做布局结构深化（沉浸式奇幻交易所方向），见文末「v2 布局大改交付」。

## 新增

- `docs/visual-redesign-checklist.md`：页面/组件 × 改造点清单与交付总结（设计 Token、非显而易见取舍、已知风险、验证记录）。已登记至 [项目协作文档索引.md](../项目协作文档索引.md)。
- `progress/FIX-visual-redesign.md`：本文件。
- `apps/web/app/styles.css` 内新增样式模块（无新文件）：`:root` 设计 Token（色板/字体/圆角/鎏金双投影/原创 SVG feTurbulence 噪点）、`@keyframes reveal-in`（开包卡面翻开/发光）、`.hud/.hud-item/.hud-amount`（HUD 状态栏）、`.side-nav-group/.side-nav-title`（侧栏分组）、`.section-divider`（菱形分隔）、`prefers-reduced-motion` 收敛、antd 暗色组件覆盖、decks 模块缺失的 `--surface/--border/--muted` 变量。

## 修改

- `apps/web/app/styles.css`：从「米白底 + 橄榄绿」管理后台风格整体替换为「暗色奇幻·卡牌交易所」：body 炭黑 + 噪点、鎏金/血红/羊皮纸按钮、金色发光焦点、双线框弹窗、账本风格表格、目录陈列柜、认证烛光门扉卡片、骨架 shimmer、窄屏适配。
- `apps/web/providers/app-providers.tsx`：新增 antd ConfigProvider（`zhCN` + `darkAlgorithm` + token/components 与 CSS Token 同源），Tag/Table/Modal/Popover/Descriptions/Pagination/Spin 全部暗色对齐。
- `apps/web/components/navigation-shell.tsx`：玩家顶栏新增 HUD（金币 SVG + 金色 tabular 余额、工作资金领取状态、服务端自然日，全部来自 `useArchiveQuery`/`useDailyWorkFundingStatusQuery` 的服务端返回）；侧栏按职能分组（玩家：大厅/市场/卡牌经营/赛事与成长/数据；管理：总览/同步/交易/运营/账户/系统），选中项 `aria-current` 鎏金高亮 + 菱形指示；管理侧新增「价格历史」玩家入口。
- `apps/web/components/card-image-popover.module.css`、`catalog-card-detail-modal.module.css`、`market/price-history-chart.module.css`：卡图鎏金卡框与暗色占位、图表图例色标同步。
- `apps/web/components/market/price-history-chart.tsx`：ECharts 坐标/分割线改暗色 Token；swatch 判定串与系列色常量同步（金 `#c9a24b` / 蓝 `#3b7dd8`）。
- `apps/web/features/market/price-history-page.tsx`：双曲线配色常量改为新 Token 色。
- `apps/web/features/*/…module.css`（market、price-history-page、orders、inventory、packs、tournaments、achievements、exports、decks、catalog、admin 共 10 个模块文件）：各页面换肤，含账本表格、鎏金数值、金/血红盈亏、稀有度徽章、双线框弹窗、开包揭晓动画增强（可跳过）、竞技场布告板、奖杯陈列柜、任务卡片化。
- `项目协作文档索引.md`：登记 `docs/visual-redesign-checklist.md` 为全站视觉唯一事实来源，并新增 2026-08-04 基线状态行。

## 删除

- 无（`styles.css` 旧浅色规则被 Token 规则整体替换，无残留死规则；未删除任何文件）。

## 特殊点

- 权威边界：纯皮肤层改动，未触碰 contracts、API、规则、迁移、数据流与 DOM 语义；浏览器仍只展示服务端真相、只提交用户意图。HUD 余额/工作资金全部来自既有只读服务端查询，失败/无数据时不渲染占位，不推导任何经济值。
- 非显而易见取舍：①侧栏分组为唯一结构性改动，链接 href/label/`aria-label` 不变，分组标题 `aria-hidden` 纯装饰；②decks 模块的 `--surface/--border/--muted` 此前从未定义（渲染透明），本次补齐为 Token 别名属修复而非行为变更；③ECharts 双曲线仅改展示色，swatch 判定串与系列色常量同步；④导航选中 `aria-current` 只在客户端 `useEffect` 内写入，避免 SSR/客户端 hydration 不一致导致导航树被 React 重挂（曾造成 `/packs` 加载态断言超时，已修复后单独通过），玩家/管理导航的 href、label 与基线完全一致。
- 已知限制：antd Popover/Modal 过渡动画由 antd 控制，`prefers-reduced-motion` 已全局收敛 CSS 动画但不额外关闭 antd 过渡（非数据动画，不影响语义）。
- 验证：`pnpm --filter @mtg-market/web check`、`pnpm lint`、web vitest（5 例）、`next build` 通过。Playwright 全量复跑已按协作约定（AGENTS.md 第 7 节 E2E 执行策略）停止：本机自动运行 e2e 会因超时/内存耗尽使 WSL 崩溃，改由用户手动执行并把结果记录到 AGENTS.md「手动测试记录」节或 `apps/web/tests/manual/`。Agent 在隔离端口 + `NEXT_DIST_DIR` 下完成的部分桌面抽查：packs / market / orders 通过；`packs.spec.ts:260` 因导航 `aria-current` hydration 不一致失败已修复；auth.spec / admin-catalog-sync.spec 含硬编码 `localhost:3001` 直连断言，开发服务占用 3001 时须由用户另行手动复跑。

---

# v2 布局大改交付（2026-08-04，沉浸式奇幻交易所）

## 新增

- `apps/web/app/styles.css` 内新增装饰原语（无新文件）：`:root` 补充 `--panel-bg`/`--panel-bg-strong`/`--panel-inset-line`/`--seal-shadow`/稀有度描边变量；`.panel`（双线框+角饰）、`.panel-title`（菱形标题）、`.notice-board`（告示板）、`.stat-chip`、`.seal`（价格图章）、`.card-frame[data-rarity]`（稀有度卡框）、`.foil`（包体闪箔）、`.rarity-dot`（稀有度色点）、`.landing-*`（英雄区/陈列卡位/特性卡图标）、`.auth-door-*`（门扉装饰）、`.case-*`（陈列柜卡位）、`.feature-icon`、滚动条暗金样式。全部原创 CSS，无素材。

## 修改

| 文件 | 说明 |
| --- | --- |
| `apps/web/app/styles.css` | v2 布局深化：顶栏鎏金 HUD 条（双线金边/品牌徽记框/HUD 分隔线/日期章）、侧栏分组标题 ◆+金线 + 链接 hover 滑条 + 选中宝石发光 + 右侧金边、内容区暗角斜纹与宽度 1280px、`.page` 顶部鎏金细线、按钮金色扫光、弹窗四角宝石、状态卡左侧金条、账本册顶线、`balance-grid` 首卡（净资产）跨行放大、`.catalog-filters` 筛选面板、antd 表格圆角/分页 hover、全部覆盖型伪元素 `pointer-events: none` |
| `apps/web/providers/app-providers.tsx` | antd token 补充 `colorLink`/`controlOutline`/Button/Tag/Select 组件覆盖 |
| `apps/web/providers/toast-provider.tsx` | Toast 加原创图标（`ToastIcon`，`aria-hidden`）+ 金色左条；role/时长逻辑未动 |
| `apps/web/components/navigation-shell.tsx` | 侧栏链接加原创 stroke 内联 SVG 图标（`NavIcon` 15 种，全部 `aria-hidden`）；链接文案/href/`aria-label` 未动 |
| `apps/web/components/catalog-card-detail-modal.tsx` | 卡图包进稀有度卡框（`data-rarity` 驱动描边与发光） |
| `apps/web/features/landing-page.tsx` | 英雄区：品牌纹章 SVG + 五枚稀有度陈列卡位 + 特性卡图标（全部 `aria-hidden`）；文案/按钮原样 |
| `apps/web/features/auth/login-page.tsx`、`register-page.tsx` | 增加左右门扉装饰元素（`aria-hidden`） |
| `apps/web/features/dashboard/player-dashboard-page.tsx` | 资产区改「大厅告示板」（`notice-board` + 首卡横跨放大金字）；每日工作资金改 `panel` 双线框 |
| `apps/web/features/collection/collection-page.tsx` | 进度区告示板化 |
| `apps/web/features/catalog/catalog-page.tsx` | 行内名称前加稀有度色点（`rarity-dot`，`aria-hidden`） |
| `apps/web/features/market/market-page.tsx` | 指数区告示板化；报价原因展开区改 `panel` |
| `apps/web/features/orders/orders-page.tsx` | 订单簿买卖方双色布告栏（`bookBids`/`bookAsks`）；两个区块改 `panel` + `panel-title` |
| `apps/web/features/orders/orders-page.module.css` | `bookBids`/`bookAsks` 双色面板与标题菱形 |
| `apps/web/features/packs/packs-page.tsx` | `PackCard` 改「包体卡」：竖式包体图形（`packGraphic`，原创斜纹/闪箔/金印/宝石）+ 价格图章；包体图形内文字为固定装饰 `PACK`；按钮文案与列表顺序不变 |
| `apps/web/features/packs/packs-page.module.css` | `cardTop`/`packGraphic`/`packBanding`/`packGem`/`packName`/`cardTitleRow` 包体卡样式 |
| `apps/web/features/inventory/inventory-page.module.css` | 盈亏改金/血红圆形徽章 |
| `apps/web/features/decks/decks-page.tsx` | 编辑器面板标题统一 `panel-title` 装饰 |
| `apps/web/features/tournaments/tournaments-page.module.css` | 卡片/区块顶部金线 + 状态章内发光 |
| `apps/web/features/achievements/achievements-page.tsx` + module | 奖杯陈列柜：解锁金/未解锁灰奖杯图标（`aria-hidden`） |
| `apps/web/features/exports/exports-page.module.css` | 任务卡片顶部金线 + 标题菱形；状态徽章换装（running 改金色） |
| `apps/web/features/market/price-history-page.module.css` | chartCard 顶部金线 + 标题菱形 |
| `apps/web/features/admin/admin-shared.module.css` | `.card` 顶部金线 + 标题菱形；stat 卡内高光 |
| `apps/web/features/admin/catalog-sync-admin-page.module.css`、`price-sync-admin-page.module.css`、`order-risk-admin-page.module.css` | 卡片/表格顶部金线 |
| `docs/visual-redesign-checklist.md` | 追加「v2 布局大改」小节（设计系统/共享组件/页面 × 改造点、未改动约束、验证） |
| `项目协作文档索引.md` | 追加 2026-08-04 视觉 v2 布局大改基线行 |

## 删除

- 无（未删除任何文件；v2 全部在既有文件内新增/修改样式与装饰结构）。

## 特殊点（v2）

- 权威边界：纯前端皮肤/布局层，未触碰 contracts、API、规则、迁移、数据流与 DOM 语义；浏览器仍只展示服务端真相、只提交用户意图。
- 非显而易见取舍：①全部新增装饰（图标/陈列卡位/门扉/伪元素）一律 `aria-hidden` 或 `pointer-events: none`，不贡献可访问名、不拦截点击；②仪表盘净资产卡横跨整行放大由 `.balance-grid article:first-child` 实现，DOM 结构与语义未动（e2e 的 `region`/`article` 定位安全）；③补充包包体图形内文字使用固定装饰 `PACK` 而非包名，避免 `packs.spec.ts` 中 `getByText("测试补充包")` strict-mode 断言因重复文本命中而失败；④侧栏图标只作用于链接内部装饰，链接文本节点与 `aria-label` 原样，`player-loop.spec.ts` 的精确链接名断言安全；⑤内容区宽度 1100px→1280px 仅影响大屏数据密度，窄屏断点未改。
- 已知限制：v2 仍为纯样式/布局层，e2e 全量复跑待用户手动执行（AGENTS.md 第 7 节）；`prefers-reduced-motion` 已收敛 CSS 动画，antd 过渡未额外关闭。
- 验证：`pnpm check`（全仓）、`pnpm lint`、web vitest 5 例、`next build` 全部通过。
