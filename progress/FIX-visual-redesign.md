# FIX 全站视觉重构：暗色奇幻·卡牌交易所

日期：2026-08-04

类型：非迭代 UI 皮肤重构（纯前端样式层），改动清单与约束见 [docs/visual-redesign-checklist.md](../docs/visual-redesign-checklist.md)。

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
