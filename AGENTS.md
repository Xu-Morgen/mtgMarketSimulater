# MTG Market Simulator — 工程协作约定

本文件适用于仓库根目录及其所有子目录。子目录中的 `AGENTS.md` 可补充更严格的局部约定，但不得削弱本文件的安全边界、权威边界和质量门禁。

## 1. 项目定位与当前阶段

- 面向 5–10 名玩家的单机部署卡牌市场模拟器；使用虚拟货币，不接入真实支付或真实卡牌交易。
- 技术组织为 TypeScript + pnpm workspace：`apps/web`、`apps/api`、`apps/ai`、`packages/contracts`、`packages/rules`。
- 当前基线为工程骨架。实现顺序、验收标准与发布门禁以《完整项目迭代实施计划与检查清单》为准；未完成当前迭代的 checklist，不开始下一迭代的业务实现。
- 不因实现方便而提前引入 Redis、PostgreSQL、微服务或浏览器直连外部数据源。

## 2. 不可突破的权威边界

1. Fastify API + SQLite 是余额、库存、开包、订单、比赛、奖励和审计的唯一写入者。
2. 浏览器只展示服务端结果并提交用户意图；不得结算、推导或持久化余额、报价、掉率、赛果、保证金、奖励等经济真相。
3. AI 仅能处理已结算赛事的最小化摘要并生成可校验叙事；不得访问或影响经济、比赛结算、库存、价格、订单或管理写操作。
4. 所有可结算规则必须位于 `packages/rules`，采用无副作用的纯函数和明确输入/输出；API、数据库、前端、AI 均不得复制规则。
5. Scryfall、MTGJSON、OpenAI 是非权威外部输入：服务端校验、记录来源与版本，失败时保留最近成功数据或模板结果。

## 3. 一致性、幂等与审计

- 所有变更类 API 必须要求并处理 `Idempotency-Key`；同一调用者和同一键的重放必须返回首次已完成结果，冲突必须使用统一错误语义。
- 金额使用整数最小货币单位，禁止浮点结算。时间使用 UTC ISO 8601；展示层按用户时区格式化。
- 余额不得直接修改，必须经账本流水变更；库存、锁定、订单状态、奖励、后台配置变更都必须保留不可变流水或审计记录。
- 一次经济操作中涉及余额、库存、锁定、订单和相关流水时，必须在一个短 SQLite 事务内完成；不得留下半完成状态。
- 并发、重试、启动补跑和任务重复领取均按“至少执行一次、业务结果至多一次”设计，并以唯一约束、状态机和幂等键落实。
- 日切、同步、订单到期、比赛结算与叙事生成必须可安全重跑；外部同步失败不得删除最后成功的目录、价格或存档数据。

## 4. 分层、依赖与目录

### `apps/api`

依赖方向为 `api → application → domain`，`infrastructure → application ports → domain`。

- `src/modules/<domain>/api`：路由、输入输出 DTO、鉴权、HTTP 状态与幂等键提取；不写 SQL 和业务规则。
- `application`：用例入口、授权、短事务编排、跨模块协作和审计触发。
- `domain`：模型、不变量与领域策略；不依赖 Fastify、SQLite、环境变量、外部 SDK。
- `infrastructure`：仓储、SQLite、文件与外部服务适配；不承载业务决策。
- 模块只能通过其他模块的 application 命令/查询接口或 contracts 事件协作，禁止跨模块读写表或直接引用对方 infrastructure。
- 配置集中在 `src/config`，启动时解析和校验；日志使用结构化 Pino 字段，严禁记录密码、令牌、密钥或敏感输入。

### `apps/web`

- `app/` 仅放 App Router 路由、布局、加载和错误边界，页面逻辑放 `pages/`。
- 服务端真相只进入 TanStack Query；Zustand 仅用于筛选、动画、未提交草稿和界面偏好。
- DTO 必须从 `@mtg-market/contracts` 导入；写操作集中于 `api/` mutation，并生成幂等键；成功后用服务端响应更新或失效相关查询。
- 页面必须覆盖加载、空数据、错误和重复提交状态；仅展示服务端返回的费用、价格、奖励、赛果和数据新鲜度。

### `apps/ai`

- 依赖方向为 `worker → application → domain`，`infrastructure → application ports → domain`。
- OpenAI 调用只在 `infrastructure/openai` 中实现，使用受服务器配置控制的、无工具的 Structured Outputs。
- 任意超时、限流、非 JSON、Schema/内容校验失败必须记录并降级为模板战报；绝不回滚或改写已结算结果。

### 共享包

- `packages/contracts`：跨层 DTO、错误码、响应包络、分页、请求 ID、幂等协议与事件契约的唯一来源。
- `packages/rules`：版本化纯规则；禁止依赖框架、数据库、HTTP、环境变量和 AI SDK。规则输入必须包含所需版本、参数与随机种子，输出应可重放。
- 新增共享能力前先确认其归属；不要在 `apps/*` 重复定义共享类型、错误码或可结算算法。

## 5. TypeScript 与工程风格

- 使用 TypeScript 严格模式、ESM 与现有 NodeNext 模块解析；保持现有 `.js` 相对导入后缀约定。
- 使用明确的类型、`type` 导入和语义化命名；避免 `any`、隐式可变的全局状态和无边界的工具函数。
- 一文件一项清晰职责。业务代码按领域就近放置，跨层稳定抽象才进入 `shared`/`utils`；不创建空泛的 `common`、`helpers`、`types` 桶目录。
- 函数优先小而可测试；规则与状态转换返回明确结果或领域错误，不以静默回退掩盖经济异常。
- 注释解释边界、原因或不变量，不重复代码表意。面向用户的文案使用中文并与产品术语一致。
- 不修改生成物、运行时 SQLite 数据库、WAL/SHM、快照、图片缓存或密钥文件，除非任务明确要求；运行时数据不纳入源码提交。

## 6. API、安全与外部数据约定

- API 输入在边界处校验，使用统一响应包络、错误码、请求 ID 和 HTTP 语义；新增写端点需记录调用者、幂等键、实体和结果摘要。
- 鉴权采用短期 access token + 可撤销 HttpOnly refresh cookie；密码使用 Argon2id；管理员操作必须角色保护且写审计。
- 不将服务端密钥、数据库路径、内部任务信息或外部 Provider 原始响应暴露给浏览器。`NEXT_PUBLIC_*` 仅能包含可公开配置。
- SQLite 使用 WAL、外键和 `busy_timeout`；未来迁移采用版本化迁移文件，启动迁移与完整性检查必须可重复执行。
- 外部数据和图片只能通过后端持久化任务访问、校验和缓存；玩家浏览页面不得触发 Scryfall、MTGJSON 或 OpenAI 请求。

## 7. 测试与变更完成条件

- 修改规则：补充 Vitest 单元测试，覆盖正常、边界、非法参数、重放/确定性行为。
- 修改 API、事务、任务或数据库：补充 Fastify inject 与临时 SQLite 集成测试，覆盖权限、错误语义、幂等、并发和回滚。
- 修改核心用户流程：补充或更新 Playwright 主流程测试，覆盖加载、空态、失败和重复点击。
- 每一迭代完成时，代码、迁移、contracts、测试、错误语义、前端状态和必要日志必须齐备；执行 `pnpm check` 与本期相关测试。
- 不得通过删除测试、放宽断言、吞掉错误或仅更新 mock 来掩盖失败。若无法验证，须在交接记录中写明原因、风险和后续检查。
- **E2E 执行策略（2026-08-04，本机 WSL2 资源约束）**：本开发机自动运行 Playwright e2e（`pnpm test:e2e` / `playwright test`）会因超时或内存耗尽导致 WSL 环境崩溃。默认**不自动运行**任何 e2e 用例；代码变更的 e2e 验证由用户手动执行。需要 e2e 时：① 用户手动运行并将结果记录到本文件「手动测试记录」节，或按迭代写入 `apps/web/tests/manual/<迭代ID>.md`；② Agent 不得代跑 e2e；③ 不得为了跳过 e2e 而删除测试、放宽断言或仅更新 mock，无法验证的项在交接记录中写明原因、风险与后续检查。

## 8. 协作文档与信息幂等

协作文档索引及每份文档的唯一事实范围、实时更新触发条件见 [项目协作文档索引.md](项目协作文档索引.md)。开始工作前先阅读与改动范围相符的权威文档；完成后在同一次变更中同步更新受影响文档。

- 一项事实只在一个权威文档中定义，其他文档只链接或摘要，避免多份内容逐渐漂移。
- 变更涉及架构、契约、规则、迁移、接口、任务、部署、验收或风险时，必须更新索引指定的记录；未决问题记录为“待决”，不可伪装为既定事实。
- 迭代状态以《完整项目迭代实施计划与检查清单》的 checkbox 为唯一准据。勾选前必须已满足该项验收并已完成对应验证。
- 文档中记录稳定标识（迭代编号、ADR 编号、规则版本、迁移编号、任务类型、验收编号）与日期；不用含糊的“最新”“之后再改”代替可追溯事实。

### 迭代完成记录

- 每次迭代完成后，必须在项目根目录的 `progress/` 中创建或更新该迭代唯一的总结文件，并与迭代完成状态在同一次变更中提交。
- 总结文件使用 `<迭代ID>.md` 命名，例如 `progress/I01.md`。文件基名必须与《完整项目迭代实施计划与检查清单》中的迭代 ID 完全一致；不得添加日期、标题、序号或其他后缀，同一迭代不得拆分为多个总结文件。
- 总结必须按“新增”“修改”“删除”分类列出本迭代涉及的仓库文件路径，并对每个文件的作用及本次变更做简要说明；删除文件还须说明原作用和删除原因。无对应文件时显式记录“无”。
- 架构或权威边界、契约或迁移、规则版本、数据兼容性、幂等与审计、安全、非显而易见的取舍、已知限制或风险等特殊点，必须在总结中单独记录；没有特殊点时显式记录“无”。
- `progress/<迭代ID>.md` 只记录该迭代已实际发生并可由变更集核对的文件事实，不代替迭代 checklist、ADR、API/运维文档或验收证据。

## 9. 常用命令

```bash
pnpm install
pnpm dev
pnpm dev:web
pnpm dev:api
pnpm dev:ai
pnpm check
pnpm build
```

运行前复制各应用的 `.env.example` 到本地环境文件并填写必要的服务端配置。任何 `OPENAI_API_KEY` 仅允许置于 `apps/ai` 的服务端运行环境。

## 10. 手动测试记录

e2e 验证默认由用户手动执行（见第 7 节 E2E 执行策略）。每次手动测试后在此追加一条记录，保持可追溯：

```markdown
### <日期>：<变更/迭代标识，例如 I32F 或 FIX-visual-redesign>
- 运行命令：<例如 pnpm --filter @mtg-market/web test:e2e --grep "packs" ...>
- 环境：桌面 Chromium / 390px 窄屏 / 其他
- 结果：<通过 N / 失败 M>，失败用例：<用例名 + 原因>
- 资源状况：<内存/耗时，是否出现 WSL 卡死>
- 截图/证据：<路径或留空>
- 备注：<阻塞点、需要修复的问题>
```

### 2026-08-05：FIX-e2e-i33f-i34f-i35f-i36f-regression（30 例 e2e 失败回归修复）
- 状态：**待用户手动 e2e 复跑**（本机自动运行会因超时/内存耗尽使 WSL 崩溃，未代跑）。
- 已由 Agent 完成并通过的自动化：`pnpm check`（含全仓 lint + 各包 tsc）、web vitest 5 例。回归来自一次全量 e2e 运行产生的 30 例失败（桌面+窄屏各 15 个用例），按 trace/error-context 归类为四类根因并已修复：
  1. `inventory-page.tsx` 条件 Hook 违规：`batchSkuIds` 的 `useMemo` 位于 `isPending/isError` 提前返回之后，加载完成时抛 "Rendered more hooks" 并触发整页错误边界，导致 inventory/orders/npc-sell/collection-album/market 库存类用例全部失败；已上移到提前返回之前（依赖改为 `inventory.data`）。这是本次回归影响面最大的单一根因。
  2. `packs.spec.ts` 开包 fixture 缺 I33B 新增必填字段 `totalCost/totalGameValue`，`CostValueComparison` 对 `undefined` 调用 `formatMoney` 抛 TypeError 整页崩溃；已补 fixture，并给 `CostValueComparison` 增加 `gameProfitLoss === undefined` 的防御分支（服务端可能给出估值但暂无盈亏差额）。
  3. 三条定位器非精确/数量断言：market 页 `heading 市场`、价格提醒页 `heading 价格提醒` 与子标题歧义触发 strict mode；tasks 页「进行中」今日/本周各一个触发 strict mode；onboarding 页当前步骤显示「下一步」故「待完成」实际为 5（断言 6 与页面语义不符）。分别改 `exact: true`、`.first()`、`toHaveCount(5)`。
  4. collection-album/market 批量对话框二次确认「重复点击」用 `click({ force: true })`：按钮点击后随即禁用且文案改变（「正在由服务端…」），locator 因名称变化无法再次解析而超时；改为 `click({ clickCount: 2 })`（一次可操作性检查后连点两次，配合弹窗内 `confirmationLock` 仍验证只投递一次）。
- **第二轮（用户复跑后剩 15 例失败，桌面+窄屏）**，按新 error-context 修复：
  5. 批量二次确认仍需一次可操作性检查即派发两次点击：`click(); click({ clickCount: 2 })` 会在两次动作间重新解析 locator（按钮已改名/禁用）导致超时；统一改为单次 `confirm.dblclick()`（与 orders/npc-sell/onboarding/tasks 既有通过用例同款），弹窗内 `confirmationLock` 同步守卫仍验证只投递一次。
  6. `price-history-page.tsx` 浏览意图（view_event）重复投递：dev StrictMode 对同一次挂载执行 setup→cleanup→setup，`useState` 守卫第二次仍是旧值导致 POST 两次（onboarding 用例 `viewCalls` 断言 2≠1）；守卫改为同步 `useRef`（两次 setup 间保留），同实例只提交一次。
  7. market 页 `link 价格提醒` strict mode（侧栏导航 + intro 内 text-button 同名链接）：改为 `getByLabel("玩家导航")` 内限定；价格提醒页列表方向徽标实际渲染为「≤ 跌到或低于」（页面 `directionLabel` 输出 `≤ 跌到或低于`，原断言「跌到或低于（≤）」为选项文案）→ 改断言文案。
  8. packs:144 卡牌详情弹窗断言 strict mode（开包卡片与弹窗内各一个占位文案）：限定 `getByLabel("卡牌详情")` 弹窗内；packs:291 加载态 `[aria-busy]` 断言在窄屏选到被隐藏的路由级 loading 占位（`app/loading.tsx`「正在加载页面」与补充包页自身骨架「正在加载补充包」同时存在）→ 用 `main[aria-busy="true"]` 过滤 `hasText: "正在加载补充包"` 锁定页面自身骨架。
- **第三轮（用户复跑后剩 9 例失败，桌面+窄屏）**，按新 error-context 修复：
  9. 市场页跌幅榜徽标实际渲染「▼ -10%」（`changeBasisPoints` 为负，`formatBasisPoints` 输出负号），原断言「▼ 10%」找不到 → 改断言文案。
  10. 批量卖出跳过明细渲染的是中文原因文案（`skipLabel(reason)`：quote_unavailable→「暂无有效报价，未卖出」、no_available_quantity→「可用库存为 0（全部被订单/比赛锁定）」），原断言匹配英文 reason 键（`/quote_unavailable/`、`/no_available_quantity/`）找不到 → 改为断言中文文案。
  11. onboarding 引导页浏览意图（view_event）只投递一次后（ref 守卫生效、trace 确认仅 1 次 POST），成功横幅仍不出现：effect 触发的 mutation 在 StrictMode 双次挂载下观察者可能被清理、`isSuccess` 不回流 → 反馈文案改用本地状态驱动（提交意图即显示，失败切错误提示），仍只提交一次意图。
  12. admin-i30f（仅窄屏）：`getByRole("link", { name: "玩家" })` 为子串匹配，「玩家首页」误命中；桌面因断言早于导航渲染通过属时序侥幸 → 三条入口断言全部加 `exact: true`。
- 需用户手动验证：本次改动的 6 个 spec（`packs.spec.ts`、`inventory.spec.ts`、`orders.spec.ts`、`npc-sell.spec.ts`、`collection-album-i33f.spec.ts`、`market-heat-watchlist-i34f.spec.ts`、`tasks-growth-i35f.spec.ts`、`onboarding-i36f.spec.ts`）桌面 + 390px 窄屏。
- 备注：`tasks.spec`/`market.spec` 的“确认”静态按钮 `force` 双击与 `ConfirmDialog` 未受影响；未改动 API、contracts、rules 与数据库。测试期间的 `tsconfig.tsbuildinfo` 为生成物，已还原不入库。

### 2026-08-05：I36F（新手引导与首次体验页面）
- 状态：**待用户手动 e2e 复跑**（本机自动运行会因超时/内存耗尽使 WSL 崩溃，未代跑）。
- 已由 Agent 完成并通过的自动化：`pnpm check`（含全仓 lint + 各包 tsc）、web tsc（`apps/web/tsconfig.json`）、web vitest 5 例、`pnpm --filter @mtg-market/web build`（`next build` 通过，`/onboarding` 路由生成）；全仓单元测试沿用 I36B 结果 contracts 17 / rules 101 / database 4 / api 257（1 跳过）。
- 需用户手动验证：`apps/web/tests/e2e/onboarding-i36f.spec.ts`（桌面 + 390px 窄屏共 5 项：引导页六步卡片/进度/入口跳转/「看懂价格」浏览意图只投递一次、跳过二次确认只投递一次与重进、完成奖励领取幂等 + 首页徽标联动、首页常驻入口徽标/待办联动 + 引导与任务进度同源一致、未创建存档的新玩家首页展示常驻引导入口）；人工记录见 [I36F.md](apps/web/tests/manual/I36F.md)。
- 备注：新增 `/onboarding` 新手引导页与玩家首页常驻引导入口（进行中/可领取/已完成徽标，未创建存档的新玩家首页同样展示）；价格历史页挂载时向服务端提交「看懂价格」浏览意图（view_event，ref 守卫只投递一次）；`daily-work-funding.spec.ts`/`player-loop.spec.ts`/`tasks-growth-i35f.spec.ts`（首页用例）补 `/v1/onboarding` mock，`price-history.spec.ts`/`market-heat-watchlist-i34f.spec.ts` 补 view_event 浏览意图 stub；导航新增「新手引导」链接不影响既有侧栏断言。

### 2026-08-05：I35F（留存钩子与成长线页面）
- 状态：**待用户手动 e2e 复跑**（本机自动运行会因超时/内存耗尽使 WSL 崩溃，未代跑）。
- 已由 Agent 完成并通过的自动化：`pnpm check`（含全仓 lint + 各包 tsc）、全仓单元测试 contracts 15 / rules 97 / database 4 / api 252（1 跳过）/ web 5 全过、`pnpm --filter @mtg-market/web build`（`next build` 通过，`/tasks` 路由生成）。
- 需用户手动验证：`apps/web/tests/e2e/tasks-growth-i35f.spec.ts`（桌面 + 390px 窄屏共 4 项：任务中心等级卡片/进度条/状态徽章/服务端周期键只读展示、任务领取二次确认只投递一次 + 成功横幅 + 状态刷新、领取失败与空态、玩家首页等级区块/任务中心入口/服务端待办「领取任务中心奖励」联动）；人工记录见 [I35F.md](apps/web/tests/manual/I35F.md)。
- 备注：玩家首页新增「等级与声望」区块（复用 GrowthCard）与「查看任务中心」入口；`daily-work-funding.spec.ts`/`player-loop.spec.ts` 已补 `/v1/growth` mock，其余既有 e2e 未改动；导航新增「任务中心」链接不影响既有侧栏断言；`PlayerDashboardDto.todos` 新增 `claim_task_rewards` 且 `TaskInstanceDto` 补充 `title/description/metricType` 展示字段。

### 2026-08-05：I34F（市场行情与交易体验页面）
- 状态：**待用户手动 e2e 复跑**（本机自动运行会因超时/内存耗尽使 WSL 崩溃，未代跑）。
- 已由 Agent 完成并通过的自动化：`pnpm check`（含全仓 lint + 各包 tsc）、全仓单元测试 contracts 13 / rules 85 / database 4 / api 245（1 跳过）/ web 5 全过、`pnpm --filter @mtg-market/web build`（`next build` 通过，`/watchlist` 路由生成）。
- 需用户手动验证：`apps/web/tests/e2e/market-heat-watchlist-i34f.spec.ts`（桌面 + 390px 窄屏共 4 项：市场页行情屏/公告区/叙事横幅/价格跳转、价格提醒页增删启停与标记已读只投递一次、订单簿盘口深度累计量/中间价/价差、库存页按筛选批量卖出幂等 + 汇总横幅）；人工记录见 [I34F.md](apps/web/tests/manual/I34F.md)。
- 备注：回归修复了 I33B/I34B 两个 API 夹具的日期敏感问题（「当日额度已用尽」的 `settlement_date` 改为与运行当天一致）；现有 market.spec / orders.spec / inventory.spec 未改动，仅补充新 spec；导航新增「价格提醒」链接不影响既有侧栏断言。

### 2026-08-04：I33F（收藏图鉴与开包体验页面）
- 状态：**待用户手动 e2e 复跑**（本机自动运行会因超时/内存耗尽使 WSL 崩溃，未代跑）。
- 已由 Agent 完成并通过的自动化：`pnpm check`（含全仓 lint + 各包 tsc）、`pnpm --filter @mtg-market/web test`（vitest 5 例）、`pnpm --filter @mtg-market/web build`（`next build` 通过，`/collection/album` 路由生成）；全仓单元测试 contracts 12 / rules 84 / database 4 / api 235（1 跳过）/ web 5 全过。
- 需用户手动验证：`apps/web/tests/e2e/collection-album-i33f.spec.ts`（桌面 + 390px 窄屏各 5 项：图鉴分组/空态/失败重试/仅持有切换/里程碑联动、新卡与重复标记、批量开包重复点击只投递一次、重复卡批量卖出幂等 + 汇总横幅、限时包 ended 禁用购买、库存页清仓入口）；人工记录见 [I33F.md](apps/web/tests/manual/I33F.md)。
- 备注：现有 packs.spec / inventory.spec / achievements.spec 未改动，仅补充新 spec；导航新增「收藏图鉴」链接不影响既有侧栏断言。

### 2026-08-04：FIX-visual-redesign（暗色奇幻·卡牌交易所全站视觉重构）
- 状态：**待用户手动 e2e 复跑**（本机自动运行会因超时/内存耗尽使 WSL 崩溃，已停止后台 sweep）。
- 已由 Agent 完成并通过的自动化：`pnpm --filter @mtg-market/web check`、`pnpm lint`、web vitest（5 例）、`next build`。
- 手动抽查结果（端口被开发服务占用时使用隔离端口 + `NEXT_DIST_DIR`）：packs / market / orders 桌面通过；`packs.spec.ts:260` 加载态断言曾因导航 `aria-current` hydration 不一致失败，已修复后单独通过。
- 需用户验证：auth.spec / admin-catalog-sync.spec 含硬编码 `localhost:3001` 的直连 API 断言，在开发服务占用 3001 时不能在本机干净运行（会污染开发库），请在其后环境空闲时手动复跑；桌面与 390px 窄屏全量主流程抽样见 `docs/visual-redesign-checklist.md`。
- **事故记录（2026-08-04）**：视觉重构样式文件曾因 `git stash push/pop` 恢复不完整而全部回落到浅色基线（`styles.css`、全部 `*.module.css`、`app-providers.tsx`），已逐文件重新写入恢复，`pnpm check` / `pnpm lint` / web vitest 全部通过。教训：涉及大面积改动时优先使用 `git diff > patch` 保存补丁再操作 stash，恢复后必须 `grep` 校验关键 Token（如 `--bg-page`、`--accent-gold`）确实存在；本机 `grep -l ... | grep -v` 组合在交互 shell 有 matcher 冲突，改用 `git status` 或分步命令核对。
