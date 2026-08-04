# 暗色奇幻·卡牌交易所 视觉重构 —— 页面/组件 × 改造点清单

日期：2026-08-04（v1 换肤）；2026-08-04（v2 布局大改）
范围：`apps/web` 全站视觉，从「米白底 + 橄榄绿按钮」管理后台风格升级为「暗色奇幻·卡牌交易所」。
约束：只换皮肤，不删逻辑、不吞错误、不改路由/导出名/React 数据流/contracts/DOM 语义；Playwright 断言不受影响（全部 E2E 均不依赖 CSS 类或颜色）。

> v2（同日）：在 v1 换肤基础上做**布局结构**深化（沉浸式奇幻交易所方向），新增装饰原语与页面级结构重构，详见文末「v2 布局大改」小节。

## 全局基础（styles.css + ConfigProvider）

| 改造点 | 处理方式 |
| --- | --- |
| 设计 Token | `:root` 集中定义色板（`--bg-page`/`--bg-panel`/`--bg-raised`/`--bg-leather`、鎏金、青铜、文本三阶、稀有度五阶、五色）、字体变量、圆角、鎏金/黑双投影、噪声纹理（原创 SVG feTurbulence） |
| 字体 | `--font-display`（中文 Noto Serif SC / 宋体系衬线）用于标题与品牌；`--font-body`（Noto Sans SC / system-ui）用于正文；数字 `tabular-nums` 对齐金额/报价/表格列 |
| 背景 | `body` 深炭黑 + 噪声纹理；页面层级背景统一 |
| 链接/焦点 | 焦点改为金色发光 outline；链接色改为鎏金 |
| 按钮 | primary 鎏金渐变、secondary 羊皮纸描边、danger 血红；hover 上浮 + 提亮、disabled 褪色 + wait 光标；提交中禁用保持醒目 |
| 面板语言 | 常规面板深色底 + 鎏金弱描边 + 内阴影 + 左上高光；重要面板（auth-card/dialog/开包结果）双线框 |
| 小节标题 | `dashboard-section h2` 前加 ◆ 菱形；`.section-divider` 菱形分隔 |
| 弹窗 | 游戏窗口：鎏金双线框（`::before` 内描边）、角落装饰、保留原聚焦管理与 aria 结构 |
| Toast | 横幅式金/绿成功、血红失败；保留 role 与时长逻辑 |
| 骨架屏 | 鎏金 shimmer 动画（保留 pulse 降级） |
| 动效 | 全站 `@media (prefers-reduced-motion: reduce)` 收敛动画；新增 `@keyframes reveal-in`（卡面翻开/发光） |
| antd 对齐 | `app-providers.tsx` 新增 ConfigProvider（zhCN + darkAlgorithm + 与 CSS Token 同源 token/components），Tag/Table/Modal/Popover/Descriptions/Pagination/Spin 全套暗色 |
| 兼容变量 | 补齐 decks 模块既有引用但从未定义的 `--surface/--border/--muted` |

## 共享组件

| 组件 | 改造点 |
| --- | --- |
| `components/ui.tsx` | 无 TSX 改动；PageSkeleton/ErrorState/EmptyState/ConfirmDialog/Pagination/FilterBar 全部由全局样式换肤（加载/空/错/重试/二次确认流程与按钮禁用原样保留） |
| `components/navigation-shell.tsx` | 新增玩家 HUD：余额（金币 SVG + 金色 tabular 数字）、工作资金领取状态、服务端自然日——仅展示 `useArchiveQuery`/`useDailyWorkFundingStatusQuery` 的服务端返回；顶栏品牌加宝石徽章；侧栏按职能分组（大厅/市场/卡牌经营/赛事与成长/数据；管理端：总览/同步/交易/运营/账户/系统），选中项鎏金高亮 + 左侧菱形指示 + `aria-current` |
| `providers/toast-provider.tsx` | 无 TSX 改动，横幅样式由全局实现 |
| `components/price-status.tsx` | 无 TSX 改动；Tag 颜色经 ConfigProvider 映射 |
| `components/card-image-popover.tsx` + module | Popover 容器深色（ConfigProvider）；图片加鎏金描边与深阴影；占位态保留语义 |
| `components/catalog-card-detail-modal.tsx` + module | Modal 深色；卡图加鎏金边框；Descriptions 暗色；占位态保留 |
| `components/market/price-history-chart.tsx` + module | ECharts 坐标/分割线改暗色 Token；色标跟随新双曲线配色（金 `#c9a24b` / 蓝 `#3b7dd8`）；swatch 判定串同步 |
| `components/health-status.tsx` | 无改动（纯 `<strong>` 文本） |
| `components/session-gate.tsx` | 无 TSX 改动；骨架/过期提示由全局换肤 |

## 页面

| 页面 | 改造点 |
| --- | --- |
| landing（`features/landing-page.tsx`） | 暗色背景 + 噪点；卡片面板换肤；按钮鎏金 |
| 登录/注册（auth-form/login/register） | 「烛光门扉式卡片」：皮革底 + 双线鎏金框；输入框深底鎏金描边；`← 返回` 链接鎏金；错误文案保留 |
| 玩家仪表盘（`player-dashboard-page.tsx`） | 余额/净资产做成「交易所大厅告示板」：数值金色高亮；市场指数与待领奖励卡片化；账本表格表头深底金字、行 hover 提亮、金额右对齐等宽；「今日循环/待办」标题 ◆ 装饰 |
| 卡牌目录（`catalog-page.tsx` + table module） | 表格换账本风格；详情弹窗卡图加鎏金卡框；来源/状态文案保留 |
| 收藏册（`collection-page.tsx`） | 陈列列表卡片化（复用全局 collection-list/balance-grid） |
| 补充包（`packs-page.tsx` + module） | 包体卡片鎏金描边；购买预览/错误/不可购买原因配色对齐；**揭晓动画增强**：已结算卡面 `reveal-in` 翻开 + 发光，隐藏卡位斜纹装饰，仍可跳过；历史卡片化 |
| 库存（`inventory-page.tsx` + module） | 账本表格；盈亏金色/血红区分（`profit`/`loss`）；锁定/可用状态徽章保留；预览触发图标换金色 |
| 市场（`market-page.tsx` + module） | 报价表格换账本风格；指数面板金色数值；NPC 报价与活动原因列表可读化；买卖弹窗深色双线框 |
| 订单（`orders-page.tsx` + module + create-order-dialog） | 订单簿方向用色（买绿/金、卖红）经 Tag 映射；状态机徽章保留文本；余额/订单簿/待履约区块深色卡片；费用/保证金预览清晰；二次确认弹窗双线框 |
| 价格历史（`price-history-page.tsx` + module） | 曲线卡片深色；范围切换按钮鎏金选中；ECharts 双曲线改金/蓝；降级表格换肤 |
| 卡组（`decks-page.tsx` + module） | 补上从未定义的 `--surface/--border/--muted` 使卡片/行/表格首次获得正确皮肤；法力符号五色系暗色化；合法性/冲突提示绿/红；编辑器面板卡片化 |
| 比赛（`tournaments-page.tsx` + module） | 「竞技场布告板」：卡片/轮次深色鎏金；赛果/奖励突出金色；报名表单输入换肤；瑞士轮/对阵列表卡片化 |
| 成就（`achievements-page.tsx` + module） | 奖杯陈列柜网格；已解锁/未解锁/风控拦截徽章（绿/灰/血红）；展示物与来源链接保留 |
| 导出（`exports-page.tsx` + module） | 文件生成任务卡片化；状态徽章换肤（生成中/可下载/失败/过期）；下载/重试禁用态醒目 |
| 管理后台全部页面（home/users/events/content/jobs/logs/backups/catalog-sync/price-sync/order-risk + admin-shared） | 「管理员工作台」暗色克制：表格密集、表头深底金字、行 hover 提亮；鎏金只用于主操作与焦点；状态徽章（草稿/预览/发布/暂停/结束/失败/标记）换肤；通知/失败横幅对齐；补偿/冻结等二次确认弹窗双线框 |
| 403/404/loading/error/not-found | 全局样式自动换肤，语义与文案保留 |

## 未改动（约束确认）

- 路由结构、页面/组件导出名、React 数据流、contracts 类型、DOM 语义角色与 aria 结构：全部未动。
- 幂等键提交、二次确认流程、同步双击锁、提交中按钮禁用：原样保留。
- 加载/空/错误/重试/禁用/过期提示：全部保留，仅换皮肤。
- 面向用户中文文案与产品术语：未改（本任务只调整样式，不改文案；空态/错误态文案保持原义）。

## 验证

- `pnpm --filter @mtg-market/web check` 通过；`pnpm lint` 通过；web vitest 5 例通过；`next build` 通过。
- Playwright 主流程抽样：auth / player-loop / packs / inventory（桌面）已跑；全量复跑见交接记录。

## 交付总结（按 新增/修改/删除）

### 新增

| 文件 | 说明 |
| --- | --- |
| `docs/visual-redesign-checklist.md` | 本盘点清单与交付总结（页面/组件 × 改造点、设计 Token、约束与验证） |
| （样式内）`@keyframes reveal-in`、`.side-nav-group/.side-nav-title/.hud/.hud-item/.hud-amount`、`.section-divider` | 开包卡面翻开/发光动画、侧栏分组与 HUD、菱形分隔的原创 CSS 实现，均内联于 `styles.css`，无新增文件 |

### 修改

| 文件 | 说明 |
| --- | --- |
| `apps/web/app/styles.css` | 设计 Token（`:root` 色板/字体/圆角/鎏金双投影/原创 SVG 噪点纹理）；全局换肤：按钮、焦点、面板、弹窗双线框、Toast、骨架 shimmer、账本表格、目录陈列、认证卡片、HUD、侧栏分组、`prefers-reduced-motion`、窄屏适配；补齐 decks 模块缺失的 `--surface/--border/--muted` 变量 |
| `apps/web/providers/app-providers.tsx` | 新增 antd ConfigProvider（zhCN + darkAlgorithm + 与 CSS Token 同源的 token/components 覆盖） |
| `apps/web/components/navigation-shell.tsx` | 玩家 HUD（余额/工作资金/服务端日期，仅展示服务端返回）+ 侧栏按职能分组 + 选中项 `aria-current` 鎏金高亮 |
| `apps/web/components/card-image-popover.module.css`、`catalog-card-detail-modal.module.css`、`market/price-history-chart.module.css` | 卡图鎏金卡框、暗色占位、图表图例色标同步新配色 |
| `apps/web/components/market/price-history-chart.tsx` | ECharts 坐标/分割线改暗色 Token；swatch 判定串与色标同步 |
| `apps/web/features/*/…module.css`（market、price-history-page、orders、inventory、packs、tournaments、achievements、exports、decks、catalog、admin 全部 10 个） | 各页面换肤为「暗色奇幻·卡牌交易所」：账本表格、鎏金数值、稀有度徽章、金/血红盈亏、双线框弹窗、竞技场布告板、奖杯陈列柜、任务卡片化等 |
| `apps/web/features/market/price-history-page.tsx` | 双曲线配色常量改为金 `#c9a24b` / 蓝 `#3b7dd8`（仅展示色，不含任何数据推导） |

### 删除

无（未删除任何文件；`styles.css` 中的旧浅色规则全部被新 Token 规则替换，无残留死规则）。

### 设计 Token 说明

- 色板、字体、圆角、阴影、稀有度五阶、五色强调全部集中在 `apps/web/app/styles.css` 的 `:root`，模块样式一律 `var()` 引用，antd 经 ConfigProvider 使用同一组值，杜绝双源漂移。
- 背景噪点为原创内联 SVG `feTurbulence`，未使用任何 MTG/外部素材；图标一律原创 stroke 风格内联 SVG（宝石/金币），无 emoji。

### 非显而易见取舍

- **侧栏分组是唯一结构性改动**：新增 `.side-nav-group/.side-nav-title` 包装与标题，但链接的 href/label/顺序不变，`aria-label`（玩家导航/管理导航）保留；管理导航新增「价格历史」入口在玩家侧，管理侧分组标题为纯装饰（`aria-hidden`），不影响读屏。
- **选中态无 hydration 不一致**：导航选中 `aria-current` 基于 pathname 的条件属性若在 SSR 阶段直接渲染会造成服务端/客户端不一致，导致 React 丢弃并重挂导航树、延迟会话恢复（曾导致 `/packs` 加载态断言超时）。已改为仅在客户端 `useEffect` 内写入 pathname（含 popstate 与 history.pushState/replaceState 兜底），SSR 阶段不渲染条件属性；玩家/管理导航的 href、label、`aria-label` 与基线完全一致。
- **HUD 全部来自服务端查询**（`useArchiveQuery`/`useDailyWorkFundingStatusQuery`），失败/无数据时不渲染任何余额占位，绝不推导；这是既有只读查询的复用，未新增任何写调用。
- **decks 模块修复**：其 `--surface/--border/--muted` 此前从未定义（渲染透明），本次补齐为 Token 别名，是修复而非行为变更。
- **ECharts 双曲线色**：仅展示色变更，无数据语义变化；swatch 判定串与系列色常量同步更新。
- 空态/错误文案沿用既有中文（如「暂无可公示的补充包」），按任务约束不把状态文案改成装饰性语句。

### 已知风险与后续

- 本改动为纯前端皮肤层，未触碰 contracts/API/规则/迁移；未改任何 Playwright 断言（无 CSS/颜色断言）。
- 全量 Playwright 复跑与本机桌面/390px 窄屏人工验收属 I32F 范围；本次已抽样验证 auth/player-loop/packs/inventory/market/orders。
- `prefers-reduced-motion` 已全局收敛动画，但 Next.js dev 下 antd Popover/Modal 过渡由 antd 控制，未额外关闭（非数据动画，不影响语义）。

---

## v2 布局大改（2026-08-04，沉浸式奇幻交易所）

### 设计系统（`apps/web/app/styles.css`）

| 改造点 | 处理方式 |
| --- | --- |
| 装饰原语 | 新增 `.panel`（双线框 + 左上角饰）、`.panel-title`（◆ 菱形 + 两侧金线）、`.notice-board`（告示板：斜纹 + 金钉角）、`.stat-chip`、`.seal`（价格图章）、`.card-frame[data-rarity]`（稀有度色卡框 + 微发光）、`.foil`（包体闪箔）、`.rarity-dot`（行内稀有度色点）——全部原创 CSS，无素材 |
| 面板统一 | `:root` 新增 `--panel-bg`/`--panel-bg-strong`/`--panel-inset-line`/`--seal-shadow`/稀有度描边变量，收敛各 module 重复的面板配方 |
| 顶栏 | 「鎏金 HUD 条」：底部双线金边（`topbar::after`）、品牌徽记框、HUD 项间竖分隔线、服务端日期做成「日期章」 |
| 侧栏 | 分组标题 ◆ + 金线；链接 hover 金色滑条；选中态金色渐变 + 宝石发光；右侧双线金边；窄屏横向滚动保留（分组标题隐藏） |
| 内容区 | 柔和暗角 + 极淡斜纹；`.content` 宽度 1100px → 1280px；`.page` 顶部鎏金细线 |
| 按钮 | hover 金色扫光微动效（`:disabled` 关闭）；disabled 褪色 + wait 保留 |
| 弹窗/状态卡 | `.dialog` 加四角宝石 + 左上高光；`.status-card` 左侧鎏金边条 + h2 菱形 |
| 表格 | antd 表头圆角、末行去底边；分页 hover 金色；滚动条暗金 |
| 筛选区 | `.catalog-filters` 包进鎏金面板 + 顶部细线（全站筛选条统一升级） |

### 共享组件

| 组件 | 改造点 |
| --- | --- |
| `navigation-shell.tsx` | 侧栏每个链接加一枚原创 stroke 内联 SVG 图标（宝石/书册/天平/剑盾/奖杯/权杖等，全部 `aria-hidden`）；链接**文案/href/aria-label 未动** |
| `providers/toast-provider.tsx` | Toast 加原创图标 + 金色左条（role/时长逻辑不动） |
| `providers/app-providers.tsx` | antd token 补充 `colorLink`/`controlOutline`/Button/Tag/Select 组件覆盖，与 CSS Token 同源 |
| `catalog-card-detail-modal.tsx` | 卡图包进稀有度卡框（`data-rarity` 驱动描边与发光） |
| `ui.tsx` | 无 TSX 改动；ErrorState/EmptyState/ConfirmDialog 由全局 `.status-card`/`.dialog` 装饰换肤 |

### 页面

| 页面 | 改造点 |
| --- | --- |
| landing | 英雄区：品牌纹章（原创盾+宝石 SVG）+ 五枚稀有度陈列卡位（纯 CSS 卡框按稀有度发光，`aria-hidden`）+ 特性卡图标；文案/按钮原样 |
| auth | 左右门扉装饰（`auth-door-left/right`，宽屏显示窄屏隐藏）+ 烛光暖晕背景；表单/按钮原样 |
| 仪表盘 | 资产区改「大厅告示板」：净资产横跨整行放大金字（`:first-child`，语义/role 未动）+ 金晕；每日工作资金改 `panel` 双线框；账本册顶部金线 |
| 收藏册 | 进度区告示板化；陈列条目加左侧金条 + hover 上浮 + 宝石角饰 |
| 目录 | 行内名称前加稀有度色点；详情弹窗卡图稀有度卡框 |
| 市场 | 指数区告示板化；报价原因展开区改 `panel` 双线框；表格原样（e2e 依赖 table 与按钮文案） |
| 订单 | 订单簿买卖方双色布告栏（买绿金/卖血红，`table` 语义保留）；「双边订单簿」「我的成交与待履约资产」区块改 `panel` + `panel-title` |
| 补充包 | `PackCard` 改「包体卡」：竖式包体图形（原创斜纹/闪箔/金印/宝石）+ 价格图章；`购买并开包`/`查看概率详情` 按钮文案与列表顺序不变；包体图形内文字为固定装饰 `PACK`（避免 strict-mode 文本断言重复命中） |
| 库存 | 盈亏改金/血红圆形徽章 |
| 卡组 | 编辑器面板标题统一 `panel-title` 装饰 |
| 比赛 | 竞技场布告板：卡片/区块顶部金线 + 状态章内发光 |
| 成就 | 奖杯陈列柜：解锁金色发光 / 未解锁灰暗奖杯图标（`aria-hidden`） |
| 导出 | 任务卡片顶部金线 + 标题菱形；状态徽章换装（生成中金/可下载绿/失败血红/过期灰） |
| 价格历史 | chartCard 顶部金线 + 标题菱形 |
| 管理后台 | 克制化：`admin-shared.module.css` 的 `.card` 顶部金线 + 标题菱形；独立 module（catalog-sync/price-sync/order-risk）同步加顶线；stat 卡内高光 |

### v2 未改动（约束确认）

- 路由、页面/组件导出名、React 数据流、contracts、DOM 语义角色与 aria 结构：全部未动。
- 全部新增装饰（图标、陈列卡位、门扉、伪元素金线/菱形/角饰）一律 `aria-hidden` 或 `pointer-events: none`，不贡献可访问名、不拦截点击。
- 侧栏导航链接文案（`补充包商店`/`市场`/`我的委托`/`我的卡组`/`比赛`/`成就` 等）与 `aria-label`（`管理导航`/`备份摘要`/`价格历史时间范围` 等）原样保留。
- 幂等键提交、二次确认流程、同步双击锁、提交中按钮禁用：原样保留。
- 加载/空/错误/重试/禁用/过期提示：全部保留，仅换皮肤。
- 面向用户中文文案与产品术语：未改。

### v2 验证

- `pnpm check`（全仓 lint + 各包 tsc）通过；`pnpm lint` 通过；web vitest 5 例通过；`next build` 通过。
- Playwright 全量复跑待用户手动执行（AGENTS.md 第 7 节 E2E 执行策略：本机自动运行会致 WSL 崩溃）。
- e2e 安全核对：packs.spec 断言 `getByText("测试补充包")` 为 strict-mode 单实例，包体图形内使用固定装饰文字 `PACK` 避免重复命中；`balance-grid` 首卡放大由 `:first-child` 实现，语义未动。
