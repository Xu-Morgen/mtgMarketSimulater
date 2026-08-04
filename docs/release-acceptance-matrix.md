# 发布验收矩阵（I32B 权威证据汇总）

> 本文件是 I32B 发布门禁的权威证据汇总，记录 AT-01 至 AT-13（AT-08 标注 I34）每个验收的自动化测试文件路径、覆盖的服务端/浏览器路径与证据状态。首发发布门禁为 AT-01 至 AT-13（**不含 I34 可选的 AT-08**）；启用 AI 前再完成 AT-08。
>
> AT 定义与前置条件/操作/预期结果以 [模拟器主流程与核心验收.md](../模拟器主流程与核心验收.md) 第 5 节为唯一来源；本表只汇总证据，不复制 AT 的定义文字。需求→迭代→资产→测试 ID 的关联见 [需求追踪表.md](../需求追踪表.md)。

## 分类约定

- **自动化断言（首发门禁，本迭代强制）**：Fastify inject + 临时 SQLite 集成测试、`packages/rules` 纯规则单测、`packages/database` 迁移/事务测试、任务/恢复测试与全局经济对账/安全门禁套件。人工验收不替代这些自动化断言。
- **浏览器自动化**：`apps/web/tests/e2e/*.spec.ts`，在 Chromium 桌面与 390 × 844 窄屏运行。
- **人工功能验收**：`apps/web/tests/manual/<迭代ID>.md`，验证真实浏览器操作、文案、视觉状态与可恢复性；属 I32F 发布前前端质量门禁的复跑范围。
- 证据状态：✅ 已通过 / 🟡 部分通过（子项未齐）/ ⏳ 未排期。

## AT-01 至 AT-13 矩阵

| 编号 | 自动化测试文件（服务端） | 浏览器自动化 / 人工验收 | 证据状态 |
| --- | --- | --- | --- |
| **AT-01** 新用户建档与初始资金只发放一次 | `apps/api/src/modules/users/api/user-routes.test.ts`（建档并发/重放、唯一存档与初始资金事务回滚）；`apps/api/src/tests/integration/economic-reconciliation.test.ts`（账户恒等式 `total = available + frozen`、`total = 账本净额` 与 `balance_after` 单调性） | `apps/web/tests/e2e/player-loop.spec.ts`、`apps/web/tests/manual/I07F.md` | ✅ 全部通过 |
| **AT-02** 每日工作资金当日只领一次 | `packages/rules/src/index.test.ts`、`apps/api/src/modules/users/domain/natural-day.test.ts`、`apps/api/src/modules/users/application/daily-rollover-service.test.ts`、`apps/api/src/modules/users/api/user-routes.test.ts`、`apps/api/src/modules/jobs/task-worker.test.ts`（IANA 时区含 DST、停机补跑、用户+日期唯一领取、防重复账本） | `apps/web/tests/e2e/daily-work-funding.spec.ts`、`apps/web/tests/manual/I23F.md` | ✅ 全部通过 |
| **AT-03A** 开包产出有效 SKU，重放不重复扣款/发卡 | `apps/api/src/modules/packs/api/pack-routes.test.ts`（CSPRNG 种子、版本过期、下架/无效包、余额不足、库存故障无半完成记录）；`packages/rules/src/index.ts` 概率/重放单测；经济对账套件覆盖开包→库存流水 | `apps/web/tests/e2e/packs.spec.ts`、`apps/web/tests/manual/I12F.md` | ✅ 全部通过 |
| **AT-03B** 参考价/游戏内价/数据状态/盈亏正确，无价显示不可交易原因 | `apps/api/src/modules/pricing/application/price-sync-service.test.ts`、`apps/api/src/modules/market/application/market-service.test.ts`、`apps/api/src/modules/pricing/application/price-backfill-service.test.ts`（每日同步、历史回填、新鲜度与降级） | `apps/web/tests/e2e/price-history.spec.ts`、`market.spec.ts`、`apps/web/tests/manual/I17F.md`、`I14F.md` | ✅ 全部通过 |
| **AT-04** NPC 买卖受价差约束，余额/库存/手续费/流水原子更新 | `apps/api/src/modules/orders/api/npc-trade-routes.test.ts`（买入/卖出预览与确认、`quantity=all`、限价保护、额度、锁定库存、同键重放/异参、事务回滚）；经济对账套件覆盖 NPC 成交→账本/库存流水 | `apps/web/tests/e2e/npc-sell.spec.ts`、`market.spec.ts`、`apps/web/tests/manual/I15F.md`、`I16F.md` | ✅ 全部通过 |
| **AT-05A** 双边委托预览准确、资金/库存/保证金正确预占，撤单释放 | `apps/api/src/modules/orders/api/order-routes.test.ts`（预览版本、限价带、费用/保证金、预占、撤单幂等释放、同键异参、额度、事务回滚） | `apps/web/tests/e2e/orders.spec.ts`、`apps/web/tests/manual/I18F.md` | ✅ 全部通过 |
| **AT-05B** 撮合价格—时间优先、部分成交、转待履约持有，不超卖/超扣/重复成交 | `packages/rules/src/index.ts` `order-matching/v1` 单测；`apps/api/src/modules/orders/api/order-routes.test.ts`（全量/部分撮合、自成交拒绝、admin 触发/玩家 403、并发、回滚） | `apps/web/tests/e2e/orders.spec.ts`、`apps/web/tests/manual/I19F.md` | ✅ 全部通过 |
| **AT-06** 模拟履约/取消履约规则正确且可审计 | `apps/api/src/modules/orders/api/order-routes.test.ts`（履约资金/库存/收入/p2p 事件/审计、取消扣保证金/恢复库存/不写 p2p 事件、到期回收、状态机防护、事务回滚守恒）；`packages/rules` `order-fulfillment/v1` 单测；经济对账套件覆盖 hold 引用闭包与 `p2p.trade.settled` 仅 fulfilled 一致性 | `apps/web/tests/e2e/orders.spec.ts`、`apps/web/tests/manual/I20F.md`、`I22F.md` | ✅ 全部通过 |
| **AT-07** Commander 合法性、报名评分快照、确定性结算、奖励/锁定释放可追溯 | `packages/rules/src/deck-rules.test.ts`、`tournament-rules.test.ts`、`local-deck-power.test.ts`；`apps/api/src/modules/decks/infrastructure/leyline-client.integration.test.ts`（默认跳过）；`apps/api/src/modules/tournaments/application/tournament-service.test.ts`、`apps/api/src/modules/tournaments/api/tournament-routes.test.ts`（禁牌版本/Companion、固定 seed 重放、瑞士/淘汰、同分加赛、现实桌全桌确认、争议赋分、跨日/重复日切不重置、奖励事务回滚）；经济对账套件覆盖赛事/成就奖励→账本流水可追溯 | `apps/web/tests/e2e/decks.spec.ts`、`tournaments.spec.ts`、`apps/web/tests/manual/I24F.md`、`I25F.md` | ✅ 全部通过 |
| **AT-08**（I33 发布后可选）已结算比赛调用 Agent，schema 错误/超时/限流时模板降级 | 未排期；I33 发布前不投递 `narrative.generate`。I34B/AI/F 提供后追加：`apps/ai`、`apps/api/src/modules/narratives/` 测试、`apps/web/tests/manual/I34F.md` | ⏳ I34 排期 | 不阻断 I32 首发或 I33 发布；I32B 安全门禁持续保证 `narrative.generate` 在 I33 前不投递/不领取。 |
| **AT-09** 无价/零价/映射失败 SKU 暂停新增交易，旧持仓用最近成功快照估值，兜底价不标为 Cardmarket 价 | `apps/api/src/modules/pricing/application/price-sync-service.test.ts`（normal/foil/etched、币种、重复映射、零价、缺失字段、checksum 错误、导入中断）；经济对账覆盖库存估值投影 | `apps/web/tests/e2e/price-sync.spec.ts`、`market.spec.ts`、`apps/web/tests/manual/I13F.md`、`I14F.md` | ✅ 全部通过 |
| **AT-10A** 成功/失败每日价格同步、checksum 不匹配管理员审计覆写 | `apps/api/src/modules/pricing/application/price-sync-service.test.ts`、`apps/api/src/modules/pricing/application/price-backfill-service.test.ts`（checksum/解析/事务失败整笔回滚、回填只补缺失日期、不移动指针） | `apps/web/tests/e2e/price-sync.spec.ts`、`apps/web/tests/manual/I13F.md` | ✅ 全部通过 |
| **AT-10B** 跨日/停机补跑/重复日切，资金与赛事按自然日正确刷新不重复 | `apps/api/src/modules/users/application/daily-rollover-service.test.ts`、`apps/api/src/modules/jobs/task-worker.test.ts`、`apps/api/src/modules/tournaments/application/tournament-service.test.ts`（日切补建赛事、停机补跑、重复执行） | `apps/web/tests/e2e/daily-work-funding.spec.ts`、`tournaments.spec.ts`、`apps/web/tests/manual/I23F.md`、`I25F.md` | ✅ 全部通过 |
| **AT-11** 基础市场事件系数不突破上限、不改外部快照；风控拦截异常订单 | `packages/rules/src/index.ts` 市场事件/系数上限单测、`order-risk/v1` 单测；`apps/api/src/modules/orders/api/order-routes.test.ts`（越界价格、冷却、频率/数量、自买自卖、高频撤单标记） | `apps/web/tests/e2e/order-risk-admin.spec.ts`、`apps/web/tests/e2e/orders.spec.ts`（I21F 玩家风控行动指引与管理端只读复核页）、`apps/web/tests/manual/I21F.md` | ✅ 全部通过 |
| **AT-12** 服务重启后快照/锁定库存/订单保证金/赛果/成就/流水/任务记录恢复 | `apps/api/src/tests/integration/backup-export-routes.test.ts`（备份/恢复演练/导出）；`apps/api/src/modules/orders/api/order-routes.test.ts` I22B 跨阶段恢复回归（SQLite 重开、worker 领取 `order.expire`）；`apps/api/src/tests/e2e/player-loop.test.ts`（闭环对账）；`apps/api/docs/operations/README.md` I32B 节恢复演练门禁 | `apps/web/tests/e2e/orders.spec.ts` I22F 恢复回归、`exports-i31f.spec.ts`、`apps/web/tests/manual/I22F.md`、`I31F.md` | ✅ 全部通过（AT-08 Agent 记录恢复属 I34） |
| **AT-13** 管理登录/越权、日志筛选/发布暂停活动、冻结/解冻/会话撤销/补偿修正、重复提交只发生一次 | `apps/api/src/modules/admin/domain/admin-domain.test.ts`、`apps/api/src/tests/integration/admin-routes.test.ts`（玩家 403、会话撤销、同键重放/异参、并发版本冲突、活动冲突/重复发布、补偿事务回滚、MTGJSON 草稿、日志只读与脱敏）；`apps/api/src/tests/integration/security-gate.test.ts`（管理命令审计与日志脱敏发布门禁） | `apps/web/tests/e2e/admin-i30f.spec.ts`、`apps/web/tests/manual/I30F.md` | ✅ 全部通过 |

## I32B 发布门禁套件（横向收敛）

以下两个集成测试套件不对应单一 AT，而是把分散在各模块的安全不变量与经济恒等式收敛为发布阻断级断言。任一失败即阻断发布。

| 套件 | 覆盖范围 | 测试文件 |
| --- | --- | --- |
| 全局经济对账 | 账户/账本恒等式与单调性、库存恒等式、冻结额守恒、库存锁定守恒、hold 引用闭包、奖励可追溯、事实事件完整性（`p2p.trade.settled` 仅 fulfilled）；终态闭环与活跃锁定中间态两场景 | `apps/api/src/tests/integration/economic-reconciliation.test.ts`（2 例） |
| 服务端安全门禁 | Argon2id 密码哈希、错误/过期/无效令牌、CSRF 与 refresh 轮换、角色边界、认证限流、输入校验与统一包络、CORS 白名单、密钥隔离与 `NEXT_PUBLIC_*` 边界、管理命令审计与日志脱敏 | `apps/api/src/tests/integration/security-gate.test.ts`（9 例） |

## 发布门禁执行清单

发布前必须在干净检出上执行（详见 [apps/api/docs/operations/README.md](../apps/api/docs/operations/README.md) I32B 节）：

1. `pnpm check`（lint + 全 workspace tsc）零错误。
2. `pnpm --filter @mtg-market/api test`、`pnpm --filter @mtg-market/rules test`、`pnpm --filter @mtg-market/database test` 全绿。
3. 全局经济对账套件 + 服务端安全门禁套件通过（步骤 2 已含，发布时可单独复跑确认）。
4. I31B 恢复演练在预备份上 `integrity_check` 通过。
5. `.github/workflows/ci.yml` 在目标 commit 上绿，GHCR 镜像已推送。
6. 不存在未解决的 P0/P1 问题。
7. I32F 完成桌面/窄屏浏览器主流程复跑与人工功能验收汇总后，前端发布门禁闭合。

## 备注

- AT-08（AI 叙事）属 I34 可选能力，I33 发布前不投递 `narrative.generate`，不纳入本矩阵的门禁。
- 浏览器主流程的桌面与窄屏复跑、页面状态核对（加载/空/错/无权限/过期/重复提交/刷新恢复/窄屏）、虚拟资产与概率说明检查属 I32F 发布前前端质量门禁，不在 I32B 后端门禁范围内。
