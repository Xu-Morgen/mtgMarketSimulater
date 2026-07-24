# I06F Playwright

`auth.spec.ts` 覆盖注册/玩家登录、刷新恢复、退出、错误密码、玩家直接访问 `/admin` 与管理 API 拒绝，以及管理员登录。`global-setup.ts` 会调用 API workspace 的 `seed-e2e-admin.ts`，只对隔离 SQLite 数据库创建或更新管理员；密码、Cookie 与令牌均不进入仓库。

默认执行 `pnpm --filter @mtg-market/web test:e2e` 会使用 `/tmp/mtg-i06f-playwright.db`，并创建 `admin-e2e@example.test` 管理员。若要使用其他隔离数据库，可设置 `E2E_DATABASE_PATH`、`E2E_ADMIN_EMAIL`、`E2E_ADMIN_PASSWORD`；`PLAYWRIGHT_EXTERNAL_SERVERS=1` 时必须同时显式提供 `E2E_DATABASE_PATH`。浏览器测试会断言路由与 API 的实际 HTTP 权限结果，而不是只检查组件。
