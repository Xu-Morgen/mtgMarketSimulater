# 前端项目架构

`apps/web` 使用 Next.js App Router。`app/` 仅定义路由段、布局、加载/错误边界与页面入口；它不承载业务数据请求、界面状态或复杂展示逻辑。路由入口应组合 `features/` 中的页面模块。`features/` 不能命名为 `pages/`，避免被 Next 识别为旧 Pages Router。

## 分层目录

| 目录 | 职责 | 依赖方向 |
| --- | --- | --- |
| `features/` | 面向业务场景的页面编排与路由入口可复用的页面模块。 | 可依赖 `components`、`stores`、`api`、`constants`、`utils`。 |
| `components/` | 可复用的展示组件、React Hook Form + Zod 表单组件、业务组件与图表/动画封装。 | 可依赖 `stores`、`constants`、`utils`；服务端数据由页面注入，或由明确的查询组件读取。 |
| `stores/` | Zustand 的瞬时 UI 状态，例如筛选、界面偏好、开包动画和未提交的卡组草稿。 | 只依赖 `constants`、`utils`；不得存放服务器真相。 |
| `api/` | API 客户端、请求封装、TanStack Query 的 query/mutation 配置及共享 contracts 类型的适配。 | 可依赖 `constants`、`utils` 与共享 `contracts` 包。 |
| `providers/` | React 全局 Provider 的集中装配，例如 TanStack Query、会话恢复与全局通知。 | 只依赖框架、`api`、`stores`、`constants`、`utils`；由 `app/` 根布局接入。 |
| `utils/` | 无业务副作用的通用工具、格式化、解析、校验与 idempotency key 生成。 | 可依赖 `constants`；不得请求 API 或读写 Zustand。 |
| `constants/` | 不会变化的前端常量、路由名、展示文案键、查询键及配置映射。 | 不依赖其他业务层。 |
| `tests/` | 前端单元、组件/集成与端到端测试，以及必要的测试夹具。 | 仅依赖被测层和测试工具；生产代码不得依赖本层。 |

## 数据与写操作规则

- 余额、库存、价格、订单、比赛、成就和后台配置均是服务器真相，只能由 TanStack Query 缓存和刷新；不得复制到 Zustand 或在浏览器计算结算结果。
- 所有 DTO 从共享 `contracts` 包导入；前端不得重定义与后端可能漂移的请求或响应类型。
- 所有变更操作由 `api/` 中的 mutation 发起，携带 idempotency key；成功后以服务端响应更新或失效相关查询缓存。
- 页面与组件只展示服务端返回的费用、保证金、奖励、赛果、开包结果和价格来源/更新时间，不推导或改写这些值。
- React Hook Form + Zod 仅提供字段级即时反馈；表单提交必须展示服务端返回的权限、版本冲突、参数上限和业务错误，不能把客户端校验当成安全边界。

## 页面模块

`features/` 按业务域建立 `auth`、`dashboard`、`catalog`、`packs`、`inventory`、`market`、`orders`、`decks`、`tournaments`、`achievements` 与 `admin`。其中买单/卖单确认是独立页面流程，必须读取服务端预览并二次确认。

`app/` 使用公开、玩家和管理员路由组组合这些页面模块。`admin` 至少拆分为首页、活动、玩家、内容/参数、任务/Agent 和日志页面；管理员布局负责导航与无权限/会话过期体验，但所有 `/v1/admin/*` 请求仍由 API 复核 `admin` 角色。

管理活动采用“草稿 → 服务端预览 → 二次确认 → 发布/定时发布 → 暂停/结束”的显式流程；玩家管理只提交冻结、解冻、会话撤销和补偿修正命令，不提供余额/库存最终值的自由编辑。审计与运行日志只读、服务端分页和脱敏，筛选条件保存在 URL 而不是 Zustand。

## 验收资产

- Playwright 主流程放在 `tests/` 的端到端测试目录，覆盖角色导航、重复点击、页面加载/空/错状态和关键玩家/管理流程。
- 每个用户可见迭代在 `tests/manual/<迭代ID>.md` 保存人工验收记录；记录构建/提交标识、浏览器、测试数据、步骤结果和截图/录屏路径。
- 单元、组件或 API 测试通过不能替代页面人工验收；对应页面、Playwright 和人工记录齐备后才满足前端完成定义。

## I33F 收藏图鉴与开包体验页面（2026-08-04）

- `api/collection-api.ts` 是 `/collection/album` 收藏图鉴只读聚合的唯一浏览器入口，只读 `GET /v1/collection/album`；查询键按用户与 `onlyHeld/cursor/limit` 隔离，不提供任何写操作。
- `/collection/album` 组合 `features/collection/album-page.tsx`：按系列分组网格展示服务端完成度百分比（`formatBasisPoints` 仅为展示格式化）、已收集/全部 SKU 数、进度条与未收集卡位灰影占位（`data-rarity` 稀有度描边仅视觉暗示，无交易/估值入口）；「全部系列/仅持有」分段切换与分页写入 URL 并只重读服务端聚合；底部「收藏里程碑联动」只读展示 `kind === "collection"` 成就的进度/解锁/奖励并跳转成就详情，不提供浏览器解锁或发奖。
- `api/packs-api.ts` 新增 `useOpenBulkPackMutation`（`POST /v1/packs/:packId/bulk` 10/50/100）：同一 `(packId, ruleVersion, count)` 网络重试复用幂等键，重新预览或任一参数变化才换键；成功后只失效 archive/ledger/inventory/pack-openings/collection album/achievements。`api/npc-trade-api.ts` 新增 `useSellDuplicatesMutation`（`POST /v1/inventory/duplicates/sell` 空请求体）：同一意图固定复用幂等键，成功只失效服务器真相缓存。
- `features/packs/packs-page.tsx` 升级：开包结果卡展示只读本地卡图（共享 `components/local-catalog-image.tsx`）+ 稀有度辉光 + `isNewToCollection` 新卡/重复徽标 + `collectionProgressAfter` 所在系列进度 + `totalGameValue`/`profitLoss.gameProfitLoss` 本包成本与服务端估值对比（盈亏红绿徽章，浏览器不重算）；`BulkPurchaseDialog` 数量选择 + 二次确认 + 同步双击锁，`BulkResultSection` 只展示服务端汇总卡片并允许逐包下钻只读结果；限时包 `OfferBadge` 展示折扣标签/剩余时间/卡池说明，`scheduled`/`ended` 窗口与下架同语义禁用购买与批量开包（购买资格仍以服务端 `offer.status` 与购买预览为准）。
- `features/inventory/duplicates-sell-dialog.tsx` 是重复卡一键清仓弹窗与结果横幅：只提交空请求体意图，二次确认 + 同步双击锁只投递一次；横幅只展示服务端返回的张数/收入/费用与跳过明细，刷新即消失不伪造成功。库存页与开包结果页均可进入。
- 动画边界：开包动画状态仍只存于可丢弃的 `stores/pack-opening-animation-store.ts`；批量开包结果直接展示服务端汇总，无动画；卡图仅经带会话的本地 API 读取，绝不访问外部图片 URL。
- `tests/e2e/collection-album-i33f.spec.ts` 与 `tests/manual/I33F.md` 覆盖图鉴分组/空态/失败重试/仅持有切换/里程碑联动、新卡与重复标记、批量开包重复点击只投递一次、批量卖出幂等与汇总横幅、限时包过期禁用、库存页清仓入口及桌面/窄屏。

## I24F Commander 卡组页面（2026-07-29）

- `api/decks-api.ts` 是草稿列表、详情、服务端合法性检查与幂等保存的唯一浏览器入口；成功保存只更新/失效当前用户的卡组查询，卡组草稿不改变库存或锁定状态。
- `/decks`、`/decks/new` 与 `/decks/[deckId]` 组合 `features/decks/decks-page.tsx`。编辑器逐页读取服务端可用库存，并原样展示可用量、订单锁定和比赛锁定；五种虚拟基本地仅作为草稿输入，不对应 SKU 或库存。
- `stores/deck-draft-store.ts` 只保存未提交名称与卡表。合法性、禁牌版本、评分来源、库存冲突和保存后的卡组均为服务器返回；未保存内容在刷新/关闭前使用浏览器离开提示。
- `tests/e2e/decks.spec.ts` 与 `tests/manual/I24F.md` 覆盖空库存、虚拟基本地、Companion、服务端合法/非法结果、评分尚未生成、锁定冲突和窄屏。

## I26F 成就与收藏里程碑页面（2026-07-30）

- `api/achievements-api.ts` 是成就概览与详情的唯一浏览器入口，只读 `GET /v1/achievements`、`GET /v1/achievements/detail`；TanStack Query 以用户 ID 隔离缓存，页面不创建 mutation 或在 Zustand 保存成就真相。
- `/achievements` 与 `/achievements/[definitionId]` 组合 `features/achievements/achievements-page.tsx`。列表展示定义和服务端进度，详情原样展示解锁、奖励状态与来源 ID；赛事、收藏和账本入口分别导向现有只读页面，不能从前端解锁、发奖或补发。
- I26B 奖励为服务端自动发放：`granted` 显示为无需领取，`blocked` 显示为风控拦截并保留解锁事实。页面不以客户端时间判断“刚解锁”或奖励状态。
- `tests/e2e/achievements.spec.ts` 与 `tests/manual/I26F.md` 覆盖空态、重复读取、自动发放/拦截状态、来源跳转及桌面/窄屏。

## I27F 玩家闭环首页与收藏册（2026-07-30）

- `api/dashboard-api.ts` 是 `/dashboard` 与 `/collection` 的唯一聚合入口，只读 `GET /v1/dashboard`；余额、完整估值的净资产、收藏统计、每日资金资格、今日赛事、市场指数和待办都来自 `PlayerDashboardDto`。领取成功只失效该用户的 dashboard/archive/ledger/daily 查询，浏览器不加总资产或生成待办。
- `/dashboard` 展示服务端余额、净资产、今日资金、今日比赛、市场指数和待办入口。报价不完整时服务端返回 `netWorth: null`，页面明确显示不可用而不展示部分估值。
- `/collection` 展示服务端收藏进度与库存快照，卡牌详情固定进入本地 `/catalog/[skuId]`；详情提供只读库存筛选和比赛入口。收藏、库存、比赛和成就都没有由浏览器直接写入的捷径。
- `tests/e2e/player-loop.spec.ts` 与 `tests/manual/I27F.md` 在桌面及 390 × 844 窄屏复核资金领取后的刷新、收藏/详情跳转及全部闭环模块入口；开包、NPC/P2P、构筑、赛事和成就的写操作仍由各自专项 Playwright 与 I27B 对账测试验证。

## I06F 已落地基线（2026-07-24）

- 根布局通过 `providers/app-providers.tsx` 装配 TanStack Query、会话恢复和全局通知。access token 只存浏览器内存，refresh token 保持 HttpOnly Cookie；会话恢复经 CSRF Cookie 调用 `/v1/auth/refresh`，不将令牌持久化到 localStorage。
- `api/client.ts` 是统一 contracts 包络和错误适配入口；认证 mutation 生成 `Idempotency-Key`，表单只提交意图并展示服务端错误。
- 公开路由为 `/`、`/login`、`/register`；`(player)` 路由组提供 `/dashboard`；`/admin` 使用独立管理布局。`SessionGate` 仅改善路由体验，管理 API 的 RBAC 仍完全由 Fastify 执行。
- `components/ui.tsx` 提供 Skeleton、错误重试、空态、确认框、分页/筛选和会话过期提示；通用样式由 Tailwind CSS 编译并保留窄屏不阻断的布局。
- Playwright 配置与 I06F 认证用例位于 `tests/e2e/`；真实人工执行记录固定写入 `tests/manual/I06F.md`。

## I07F 存档与账本页面（2026-07-24）

- `api/archive-api.ts` 集中定义存档、账本的 contracts 查询与创建 mutation；创建意图在完成前复用同一 `Idempotency-Key`，成功后以服务端存档响应更新查询缓存并失效账本缓存。
- 存档、账本等用户私有查询的 TanStack Query key 必须包含 `userId`；登录、注册和退出会清空查询缓存，禁止跨会话展示玩家或管理端服务器数据。
- `features/dashboard/player-dashboard-page.tsx` 只格式化 API 返回的整数金额，展示存档摘要、总额/可用额/冻结额、净资产占位和服务端游标分页账本；未建档、加载、失败重试、空账本、创建中与窄屏表格状态均在页面覆盖。

## I08F 卡牌目录与详情页面（2026-07-24）

- `api/catalog-api.ts` 集中定义目录列表与详情的只读 TanStack Query；请求只面向本地 `/v1/catalog/*`，查询键按登录用户和完整 URL 筛选条件隔离。
- `features/catalog/catalog-page.tsx` 将名称、系列、稀有度、工艺和游标保存在 URL，使用服务端分页结果展示每个独立 SKU；详情页保留印刷、工艺、来源、合法性及本地图片缓存状态，缺图时文字降级而不访问外部 URL。
- 玩家导航新增 `/catalog`。Playwright 夹具在隔离 SQLite 中提供同名不同印刷和工艺 SKU；I08F 用例覆盖目录分页、筛选恢复、无结果、接口失败与窄屏。

## I11F 补充包概率公示页面（2026-07-26）

- `api/packs-api.ts` 只查询本地 Fastify 的 `GET /v1/packs` 和 `GET /v1/packs/{packId}`；TanStack Query key 按登录用户与补充包 ID 隔离，页面不保存候选池、随机种子、结果或保底进度。
- `/packs` 公示服务端返回的补充包价格、规则版本、启用状态和禁用原因；`/packs/{packId}` 进一步按服务端 `probabilityBasisPoints` 显示每个卡位的稀有度概率。该 bp→百分比转换仅为展示格式化，前端不抽样或实现抽取规则。
- I11F Playwright 在桌面与 390 × 844 窄屏覆盖概率加载、空列表、禁用包、规则版本刷新和失败重试；购买/开包入口与结果交互由 I12F 扩展，人工记录固定在 `tests/manual/I11F.md`。

## I12F 补充包购买、结果与历史（2026-07-26）

- `api/packs-api.ts` 是购买预览、幂等开包和开包历史的唯一前端入口；开包 mutation 只回传预览给出的规则版本。同一 `packId + ruleVersion` 的网络重试保留同一幂等键，重新预览、切换补充包或成功完成后才开始新意图。
- `/packs` 以确认框展示服务端购买预览，开包期间禁用确认动作；成功后以服务端 `PackOpeningDto` 展示动画和结果，并失效存档、账本、库存与历史缓存。结果卡位再从本地目录读取卡名/罕贵度/缓存图详情、从服务端市场投影读取“当前市场价”；它们不改写开包成本或已结算结果。余额不足、版本过期等服务端错误保持在确认流程中，绝不制造卡牌结果。
- `stores/pack-opening-animation-store.ts` 只保存可丢弃的揭晓阶段和索引；`/packs/history` 从服务端读取已结算历史。刷新页面不会保留或重放本地开奖结果。
- I12F Playwright 与人工记录分别固定在 `tests/e2e/packs.spec.ts`、`tests/manual/I12F.md`，覆盖成功、失败、重复点击、跳过动画和刷新历史，并在桌面及窄屏执行。

## I13F 价格同步状态（2026-07-26）

- `api/pricing-api.ts` 将玩家的 `GET /v1/prices/status` 与管理端 `GET /v1/admin/prices/sync` 分成不同 TanStack Query；查询键始终包含当前用户，管理查询只在 admin 会话下启用并在任务等待/执行中轮询。
- `components/price-status.tsx` 只展示服务端公开来源、更新时间/新鲜度和 SKU 可新增交易状态，供目录、库存复用；不显示参考价金额、版本、校验和或同步失败详情，也不在浏览器推导过期状态。
- `/admin/price-sync` 复用 admin layout 的服务端 RBAC 体验，运行详情仅在管理页面展示；管理员主动刷新会先经确认框，再以新的幂等键投递 `prices.sync`，失败重试同一意图复用该键，成功后失效状态查询并轮询任务。服务端明确返回 `checksumBypassAvailable` 时页面自动弹出风险确认；覆写与普通刷新属于不同幂等意图，确认后才提交 `allowChecksumMismatch: true`。组件在无查询数据时保持加载状态，避免会话权限跳转期间读取空缓存。`tests/e2e/price-sync.spec.ts` 覆盖管理员、玩家与越权三条路径。

## I14F 市场报价页面（2026-07-27）

- `api/market-api.ts` 是市场页唯一数据入口：TanStack Query 按当前用户和完整 URL 筛选隔离 `GET /v1/market/quotes`，另读服务端市场指数；价格来源与新鲜度继续复用公开价格状态查询。它不接收、保存或计算市场规则参数。
- `features/market/market-page.tsx` 在 `/market` 展示 API 已物化的外部锚点、游戏内/NPC 报价、原因摘要和分页筛选；筛选条件写入 URL。无价或报价缺失条目依据服务端禁用原因保持不可交易，过期/失败状态不会被渲染成实时价格。
- I14F Playwright 通过可配置的本机端口启动隔离 API/Web 服务，避免复用开发者已有服务；`tests/e2e/market.spec.ts` 在桌面和窄屏验证价格展示、活动受界原因、无价禁用与失败恢复。

## I15F NPC 买入页面（2026-07-27）

- `api/npc-trade-api.ts` 是 NPC 买入预览和成交的唯一前端入口。预览 query 按用户、SKU、数量隔离且每次数量提交均重新读取；mutation 对同一个 SKU、报价标识、规则版本、数量及单位限价意图复用幂等键，重新预览后才丢弃该键。
- `features/market/npc-buy-dialog.tsx` 仅收集数量并展示服务端 `NpcBuyPreviewDto`；它既不计算总价/费用/额度，也不接受浏览器传入的价格。确认期间的 UI 禁用与成功提示只反映 mutation 状态和 `NpcTradeDto`，随后使存档、库存、账本、市场与价格状态的 TanStack Query 缓存失效。
- `tests/e2e/npc-buy.spec.ts` 覆盖桌面和窄屏的成交、重复点击、余额不足、额度、报价过期和重新预览；人工执行记录固定在 `tests/manual/I15F.md`。

## I16F NPC 卖出与库存估值页面（2026-07-27）

- `InventoryHoldingDto` 的 `marketUnitPrice`、`marketValue` 与 `unrealizedProfitLoss` 都来自服务端整数投影；`features/inventory/inventory-page.tsx` 只格式化显示单张现价、全部持仓市值和未实现盈亏，不在浏览器计算数量、成本或盈亏。锁定量仍分别展示，只有服务端标记可用的持仓才显示卖出入口。
- `api/npc-trade-api.ts` 是卖出预览和成交的唯一前端入口。`all` 直接请求服务端预览，确认仅回传预览解析后的确切数量、报价标识、版本和最低单价；同一网络重试复用幂等键，重新预览才开始新意图。确认对话框另有同步锁，避免 React 禁用状态生效前的双击发送第二个 HTTP 请求。
- `features/inventory/npc-sell-dialog.tsx` 显示服务端可用量、锁定说明、价格、费用、额度和错误语义；卖出成功仅使存档、账本、库存、市场和价格状态的 TanStack Query 缓存失效。`tests/e2e/npc-sell.spec.ts` 在桌面及窄屏覆盖 all/指定数量成交、锁定库存、数量不足、报价变化、重复点击和刷新；人工执行记录固定在 `tests/manual/I16F.md`。

## I17F 价格历史与市场曲线页面（2026-07-27）

- 玩家导航新增 `/market/history`，`app/(player)/market/history/page.tsx` 仅组合 `features/market/price-history-page.tsx`，并用 Suspense 包裹 `useSearchParams`，避免整条路由退化为客户端渲染。
- `api/market-api.ts` 新增 `usePriceHistoryQuery(skuId, range)` 与 `useMarketIndexHistoryQuery(range)`，只读本地 Fastify 的 `GET /v1/market/quotes/{skuId}/history` 与 `GET /v1/market/index/history`；TanStack Query key 按当前用户、skuId 与 `7d|30d|all` 隔离，`retry: false`。默认 30d 不强制写入 URL，仅当玩家切换时间范围或选中 SKU 时才把 `range`/`skuId` 写入 URL，刷新可恢复；不在浏览器插值、重算指数或汇率。
- `components/market/price-history-chart.tsx` 是 ECharts（`echarts@^5.6.0`）canvas 双折线组件，`connectNulls: false` 让缺失参考价/游戏内价的自然日断线、不掩盖空态；`role="img"` 配合中文 `aria-label` 描述覆盖天数与两条货币轴。页面同时渲染同名只读降级表格，便于无障碍读屏与窄屏阅读。
- 页面区分 Cardmarket EUR 参考价/指数（金色）与游戏内报价/指数（蓝色），并复用 `components/price-status.tsx` 的服务端来源、更新时间、过期状态与固定 disclaimer；`freshness=stale` 时显示“沿用最近成功快照；这不是实时 Cardmarket 价格。”，绝不渲染为空白或实时价格。空 points 显示“该 SKU/范围暂无历史快照”，查询失败显示错误重试。
- `tests/e2e/price-history.spec.ts` 在桌面与 390 × 844 窄屏覆盖默认 30d、范围切换写 URL 与重查、单卡双曲线/降级表格/空历史、`stale` 旧价降级、查询失败重试与窄屏不阻断；人工执行记录固定在 `tests/manual/I17F.md`。

## I18F P2P 委托创建与我的订单页面（2026-07-27）

- `api/orders-api.ts` 是委托预览、创建、列表、详情、撤单与只读订单簿的唯一前端入口。`useOrderPreviewQuery(skuId, side, quantity)` 按用户、SKU、方向、数量隔离且每次输入提交均重新读取（`refetchOnMount:"always"`、`retry:false`）；`useCreateOrderMutation(side)` 对同一个 `(skuId,quoteId,quoteVersion,previewVersion,quantity,limitPrice)` 网络重试复用幂等键，任一变化（含重新预览得到新 `previewVersion`）才换键。
- 创建请求体严格等于 `{quoteId,quoteVersion,previewVersion,quantity,limitPrice}`；`previewVersion` 为 64 位 hex 原样回传，`limitPrice` 为整数最小货币单位，限价带、费用、保证金、预计金额、可用量均只展示服务端 DTO，不回传或本地重算。
- `features/orders/create-order-dialog.tsx` 复用 `npc-sell-dialog` 的同步 `confirmationLock` ref 双击锁，防止 React `disabled` 渲染前的同一事件循环第二击发出第二个 HTTP 请求；`VERSION_STALE` 必须重新预览（换新幂等键），`INSUFFICIENT_*`/`INVENTORY_LOCKED`/`RULE_VIOLATION`/`IDEMPOTENCY_CONFLICT` 展示服务端 message 并提供「重新预览」。
- `features/orders/orders-page.tsx` 在 `/orders` 以服务端订单字段（方向、状态、SKU id、数量、限价、费用、预占资金/库存、版本、到期/创建时间）展示我的委托，URL 驱动 status/side/cursor/limit 筛选；撤单以幂等键提交并经 `ConfirmDialog` 二次确认，`409 RESOURCE_CONFLICT` 提示刷新后重试。成功只失效 `orders/archive/ledger/inventory/market*/prices.public-status` 缓存，不写 Zustand 或本地副本。
- 挂单入口由市场页可交易 SKU 行「挂买单」与库存页可用持仓行「挂卖单」触发；玩家导航新增 `/orders`。撮合、模拟履约、`p2p.trade.settled` 与 `order.expire` 延后至 I19B/I20B/I22B；本迭代订单只处于 `open` 状态，页面不展示撮合/履约 UI。
- `tests/e2e/orders.spec.ts` 在桌面与窄屏覆盖买单创建/双击/限价越界/余额不足、报价过期重新预览换键、卖单创建+我的委托+撤单、状态/方向筛选写 URL、空委托与查询失败；人工执行记录固定在 `tests/manual/I18F.md`。

## I23F 每日工作资金领取页面（2026-07-29）

- `api/daily-work-funding-api.ts` 是仪表盘读取资格和提交领取的唯一入口。`DailyWorkFundingStatusDto` 的自然日、时区、金额、规则版本、领取记录和下一次时间均直接来自本地 API；查询键按用户隔离，挂载时强制重取，不把资格或日期放入 Zustand。
- `useClaimDailyWorkFundingMutation` 对同一网络重试复用幂等键，并以同步提交锁阻断 React 禁用渲染前的双击。无论成功、冲突还是失败都失效每日资格、存档和账本查询；页面随后只接受服务端刷新后的可领取/已领取/未开放状态，绝不以浏览器自然日推导下一次资格。
- `features/dashboard/player-dashboard-page.tsx` 只格式化 `nextEligibleAt` 等服务端 UTC 字段到服务端 IANA 时区，展示领取对应账本类型。`tests/e2e/daily-work-funding.spec.ts` 和 `tests/manual/I23F.md` 分别保存桌面/窄屏回归与人工验收。

## 不单独建层的内容

- DTO、事件与 API 契约由共享 `packages/contracts` 提供，因此前端不建立会产生重复定义的 `types/` 层。
- 可复用交互逻辑优先归属其业务页面或组件；只有跨多个层且稳定的纯函数才进入 `utils/`，避免过早创建泛化 `hooks/` 层。
- 全局样式和路由框架文件保留在 Next.js 约定的 `app/`；组件私有样式与资源应和所属组件就近放置。静态文件按 Next.js 约定在未来需要时放入 `public/`，它是资源目录而非业务分层。
