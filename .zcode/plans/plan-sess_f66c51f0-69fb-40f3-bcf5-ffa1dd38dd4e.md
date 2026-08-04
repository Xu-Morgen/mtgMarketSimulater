# 「暗色奇幻·卡牌交易所」布局大改 v2 —— 实施计划

延续已落地的 v1 换肤，在保留全部路由/数据流/语义/文案/e2e 断言的前提下，对页面**布局结构**做沉浸式重构。

## 一、改造清单（页面/组件 × 改造点）

### A. 全局设计系统（`apps/web/app/styles.css`）
1. **内容区背景**：`.content` 加柔和暗角 + 极淡斜纹；数据页宽度放宽（1100px → 1280px，窄屏不受影响）；`.page` 顶部加鎏金细线。
2. **顶栏**：改为「鎏金 HUD 条」——底部双线金边 + 左右角饰；品牌加徽记框；HUD 项间加竖分隔线；服务端日期做成「自然日」章。
3. **侧栏**：分组标题「◆ 标题 + 金线」；链接 hover 金色滑条；选中态金色渐变条 + 宝石；窄屏横向滚动保留。
4. **新装饰原语**（全部原创 CSS，无素材）：
   - `.panel` / `.panel-title`（鎏金双线框 + 角饰 + 菱形标题）——统一各 module 里重复的 sectionCard/card/chartCard/panel 配方；
   - `.notice-board`（告示板：深底 + 木纹斜纹 + 金钉角）、`.stat-chip`（金色数据牌）、`.card-frame`（稀有度色描边卡框）、`.seal`（价格图章）、`.foil`（包体闪箔渐变）；
   - 全局滚动条暗金样式；`.num` 数字等宽工具类。
5. **按钮**：hover 加金色扫光微动效（保留 disabled 褪色 + wait）。
6. **面板统一化**：把 orders/exports/price-history/achievements/admin 等重复的「渐变面板 + gold-dim 边框 + radius-lg + shadow-panel」收敛到 `:root` 单一 `--panel-bg`/共享类，消灭配方漂移。

### B. 共享组件
7. **`components/navigation-shell.tsx`**：侧栏每组链接加一枚原创 stroke 内联 SVG 图标（宝石/金币/剑盾/杯盏/奖杯/卷轴等，全部 `aria-hidden`）；分组标题加菱形装饰；顶栏品牌徽记框 + HUD 分隔线。链接**文案/href/aria-label 一律不动**（e2e 精确匹配）。
8. **`components/ui.tsx`**：不改 TSX 结构（`PageSkeleton`/`ErrorState`/`EmptyState`/`ConfirmDialog`/`Pagination`/`FilterBar` 的 role/aria/文案原样），样式由全局升级：ErrorState/EmptyState 加装饰图标与金框；ConfirmDialog 加角饰。
9. **`providers/toast-provider.tsx`**：Toast 加金色左条 + 图标（role/时长逻辑不动）。
10. **`providers/app-providers.tsx`**：antd token 微调（如 `controlOutline` 金色发光、Table header 装饰），保持同源。

### C. 页面布局大改（按模块）
11. **landing（`features/landing-page.tsx`）**：新增英雄区——品牌纹章（原创 SVG）+ 大号衬线标题 + 鎏金双线框 + 「陈列柜」卡位装饰条（3–5 张纯 CSS 卡框按稀有度发光，`aria-hidden`）；下方三张特性卡（今日行动/市场边界/服务状态）升级为告示板。**全部文案与按钮原样**。
12. **auth（login/register/auth-form）**：烛光门扉深化——门扉式左右装饰（`aria-hidden`）、暖光渐晕、衬线标题；表单/按钮/label/错误文案原样。
13. **仪表盘（`player-dashboard-page.tsx`）**：
    - 资产区 `balance-grid` 重构为「交易所大厅告示板」：CSS `:first-child` 使净资产卡横跨整行并放大金字 + 图章，其余三枚为金色数据牌；
    - 「今日循环/服务端待办」区块加告示板标题装饰；账本流水做成「账本册」——表头金底 + 顶部菱形分隔。
    - **heading 层级、aria-label、全部按钮/链接文案原样**。
14. **目录（`catalog-page.tsx` + `catalog-table.module.css`）**：表格保留，行内名称加稀有度色点；筛选区包进装饰面板；详情弹窗卡图加稀有度色卡框（`catalog-card-detail-modal`）。`aria-label`（名称筛选等）、antd 分页类名原样。
15. **市场（`market-page.tsx` + module）**：顶部三张指数卡升级为「交易所行情牌」（金色大数字 + 图章）；报价表格保留（e2e 依赖 table + `向 NPC 买入/挂买单` 按钮文案）；报价原因展开区做成「卷轴」面板。
16. **订单（`orders-page.tsx` + module）**：`sectionCard` 统一挂「◆ 区块标题」装饰；订单簿改为「买卖双方布告栏」——买单绿金/卖单血红双色面板（`bookSide` 视觉强化，`table` 语义保留）；`region="账户余额状态"` 及内部 `article` 结构、`aria-label`（委托方向筛选/委托状态筛选/委托限价）原样。
17. **补充包（`packs-page.tsx` + module）**：`PackCard` 重构为「包体卡」——竖式包体图形（原创斜纹 + 闪箔渐变 + 顶部金印 + 价格图章）；`购买并开包`/`查看概率详情` 按钮文案与**列表顺序**不变；揭晓动画保留并增强（卡面翻开 + 稀有度色发光，仍可跳过）。`正在由服务端开包…`/`本次开包结果`/`跳过动画` 文案原样。
18. **库存（`inventory-page.tsx` + module）**：表格保留，盈亏改金色/血红徽章样式；筛选区装饰面板；锁定徽章换装。`aria-label`（库存工艺筛选等）、操作按钮文案原样。
19. **收藏册（`collection-page.tsx`）**：卡片列表升级为「陈列柜条目」——金色卡框 + 数量图章；进度区三卡复用告示板样式。
20. **卡组（`decks-page.tsx` + module）**：编辑器两栏面板统一「◆ 标题」装饰；指挥官区做成「卡座」视觉；法力符号圆徽强化；合法性状态徽章保留文案。
21. **比赛（`tournaments-page.tsx` + module）**：「竞技场布告板」深化——卡片加边饰与状态章；奖励/结果金色突出；报名弹窗双线框。按钮/文案原样。
22. **成就（`achievements-page.tsx` + module）**：奖杯陈列柜——解锁/未解锁/风控三态换金/灰/血红徽章 + 奖杯图标；详情页装饰。
23. **导出（`exports-page.tsx` + module）**：任务卡片保留，状态徽章换装（生成中金/可下载绿/失败血红/过期灰）；`不可下载` aria-label、下载按钮文案原样。
24. **价格历史（`price-history-page.tsx` + module）**：chartCard 统一装饰；`summaryHeader` 加金线；图表 `<img role="img">`、`价格历史时间范围` group、窄屏渲染原样。
25. **管理后台（admin 全部 11 页）**：克制化升级——统一「◆ 区块标题」装饰 + 表头金底 + 主操作鎏金；`aria-label`（备份摘要/风险结果筛选/单张图片 SKU ID/批量图片系列代码等）、admin h1 文案、全部弹窗标题原样。

## 二、e2e 安全保证（逐条守住）
- 不改：路由、页面/组件导出名、React 数据流、contracts、`aria-label` 清单（管理导航/备份摘要/价格历史时间范围/不可下载/全部筛选标签）、真实 `<table>`、antd 分页类 `.ant-pagination*`、弹窗标题文案、开包流程 4 句、侧栏导航链接文案与 href、`region`（账户余额状态）、图表 `img role="img"`。
- 新增装饰一律 `aria-hidden`，不贡献可访问名，不改变 heading 层级。
- 全部加载/空/错误/重试/禁用/重复提交态原样保留，只换皮肤。

## 三、实施顺序与验证
1. 全局 styles.css + app-providers + navigation-shell（含图标）→ `pnpm --filter @mtg-market/web check`。
2. ui.tsx / toast / dialogs / card-image / modal 等共享组件 → check。
3. 按模块逐页：landing → auth → dashboard → catalog → market → orders → packs → inventory → collection → decks → tournaments → achievements → exports → price-history → admin（每组后跑 check）。
4. 收尾：`pnpm lint` + `pnpm --filter @mtg-market/web check` + `pnpm --filter @mtg-market/web test`（vitest）。**e2e 按 AGENTS.md 第 7 节由用户手动复跑**（本机自动运行会致 WSL 崩溃），我在交接记录写明待验证项。
5. 文档同步：更新 `docs/visual-redesign-checklist.md`（新增 v2 布局大改小节）、`progress/FIX-visual-redesign.md`（追加 v2 记录：新增/修改/删除文件、设计 token、取舍、风险）、`项目协作文档索引.md` 基线行；按仓库约定提交到当前分支 `glm-after17`（含 progress 文件）。

## 四、不触碰
- 不改生成物、运行时 SQLite/WAL/SHM、图片缓存、密钥；不动 `package.json` 中已有的未提交改动。