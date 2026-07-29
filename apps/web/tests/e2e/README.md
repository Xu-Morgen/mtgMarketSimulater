# Playwright 主流程

`auth.spec.ts` 覆盖注册/玩家登录、刷新恢复、退出、错误密码、玩家直接访问 `/admin` 与管理 API 拒绝，以及管理员登录。`global-setup.ts` 会调用 API workspace 的 `seed-e2e-admin.ts`，只对隔离 SQLite 数据库创建或更新管理员；密码、Cookie 与令牌均不进入仓库。

默认执行 `pnpm --filter @mtg-market/web test:e2e` 会使用 `/tmp/mtg-i06f-playwright.db`，并创建 `admin-e2e@example.test` 管理员。若要使用其他隔离数据库，可设置 `E2E_DATABASE_PATH`、`E2E_ADMIN_EMAIL`、`E2E_ADMIN_PASSWORD`；`PLAYWRIGHT_EXTERNAL_SERVERS=1` 时必须同时显式提供 `E2E_DATABASE_PATH`。浏览器测试会断言路由与 API 的实际 HTTP 权限结果，而不是只检查组件。

`packs.spec.ts` 是 I11F–I12F 补充包流程用例：在浏览器层模拟本地 Fastify 的补充包配置、购买预览、开包和历史响应，覆盖服务端结果展示、余额不足、版本过期、提交禁用、跳过动画和刷新历史。测试不模拟外部数据源，也不在浏览器实现抽取规则。

`daily-work-funding.spec.ts` 是 I23F 仪表盘每日工作资金回归：只模拟本地的服务端资格、领取和账本响应，覆盖可领取、已领取、快速双击、领取后刷新、跨日冲突和服务器 IANA 时区变化；浏览器不依据本地日期或余额计算资格。
