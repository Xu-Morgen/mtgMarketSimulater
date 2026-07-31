# MTG Market Simulator

轻量单机版卡牌市场模拟器 workspace。适用于 5–10 名玩家：本地 SQLite、Scryfall Bulk Data 卡池、MTGJSON 每日价格快照，以及 **I33 发布后才可启用的可选 AI 比赛叙事**。

## 项目结构

- `apps/web`：Next.js 前端，只负责展示与提交用户意图。
- `apps/api`：Fastify API、本地 SQLite 与持久化任务循环，唯一的经济结算入口。
- `apps/ai`：I33 发布后可选启用的 AI 赛事叙事模块，只输出经过结构校验的文本，不拥有经济系统权限。
- `packages/contracts`：前后端与 AI 共用的类型和事件契约。
- `packages/rules`：纯规则函数，后续放置开包、报价、比赛、订单和成就计算。

## 开始

```bash
pnpm install
pnpm dev
```

首次运行前复制环境示例：

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
cp apps/ai/.env.example apps/ai/.env
```

`apps/api` 与 `apps/ai` 只在启动边界解析其服务器配置；`apps/web` 只允许 `NEXT_PUBLIC_*` 配置。I33 发布前无需配置 AI；I33 后决定启用 I34 AI 叙事时，才将 `OPENAI_API_KEY` 配置在 `apps/ai/.env`，绝不能发送给浏览器或写入 `apps/web`。

## 环境与质量门禁

开发环境使用示例中的固定端口：Web 为 `http://localhost:3000`，API 为 `http://localhost:3001`，SQLite 默认写入 `apps/api/data/`。可分别运行 `pnpm dev:web`、`pnpm dev:api` 和 `pnpm dev:ai`；根目录 `pnpm dev` 同时启动 Web 与 API。若端口已被占用，先停止占用进程；不要让 Web 自动换端口，否则它将不再匹配 API 的 `WEB_ORIGIN` CORS 白名单。

测试环境设置 `APP_ENV=test`，并为 API 指定临时 `SQLITE_PATH`，不得复用开发数据库。执行 `pnpm check` 与 `pnpm format:check`；测试命令见下方「测试」章节。测试脚本将临时目录固定为 Linux 的 `/tmp`，避免宿主机路径泄漏到测试运行时。

生产环境设置 `APP_ENV=production`、受限的 `WEB_ORIGIN` 与持久化的绝对 `SQLITE_PATH`；通过 `pnpm build` 生成产物，再分别执行 API 的 `pnpm --filter @mtg-market/api start` 和 AI 的 `pnpm --filter @mtg-market/ai start`。Web 使用 `pnpm --filter @mtg-market/web start`。真实密钥只由部署平台注入，不提交 `.env` 文件。

## 测试

仓库有两类测试，命令分层：

| 命令 | 含义 |
|---|---|
| `pnpm test` | 完整测试：先跑 `pnpm test:unit`（所有 workspace 的 Vitest），再跑 `pnpm test:e2e`（Playwright）。 |
| `pnpm test:unit` | 只跑 Vitest 单元/集成测试（API + Web）。Web 的 `vitest.config.ts` 显式排除了 `tests/e2e/**`，不会误收 Playwright 用例。 |
| `pnpm test:e2e` | 只跑 Playwright 浏览器端到端测试，转发到 `apps/web` 的 `test:e2e` 脚本。 |

两类测试的隔离方式不同：

- **API 集成测试**（Vitest + Fastify inject，位于 `apps/api/src/tests/`）：进程内注入请求，每个用例用 `mkdtempSync` 在 `/tmp` 建一次性 SQLite，跑完即删，从不复用开发数据库。
- **Web 浏览器 E2E**（Playwright，位于 `apps/web/tests/e2e/`）：Playwright 会自动启动一个绑定隔离测试库（默认 `/tmp/mtg-i06f-playwright.db`，可用 `E2E_DATABASE_PATH` 覆盖）的独立 API 与 Next dev。配置强制不复用正在运行的开发服务器（`reuseExistingServer: false`），否则会静默把测试注册请求写进开发库污染真实账号；若端口被 `pnpm dev` 占用会直接报端口冲突。

### 跑 Playwright E2E 的前置条件

1. **首次需安装浏览器**（`pnpm install` 只装 npm 驱动包 `@playwright/test`，不下载 Chromium；浏览器二进制约 150MB，缓存在 `~/.cache/ms-playwright/`，全局共享，重装依赖无需重下）：

   ```bash
   pnpm --filter @mtg-market/web exec playwright install chromium
   ```

2. **先停掉 `pnpm dev`**：E2E 不复用运行中的服务器，3001/3000 端口必须空闲。

### 常用变体

```bash
# 单个 spec 文件
pnpm --filter @mtg-market/web exec playwright test tests/e2e/auth.spec.ts

# 按用例名关键词过滤
pnpm --filter @mtg-market/web exec playwright test -g "管理员登录"

# 只跑 chromium project（默认有 chromium 与 narrow-chromium 两个）
pnpm --filter @mtg-market/web exec playwright test --project=chromium

# 带 UI 面板交互调试
pnpm --filter @mtg-market/web exec playwright test --ui

# 每步留 trace + 截图（失败排查最常用）
pnpm --filter @mtg-market/web exec playwright test --trace=on

# 仅跑 API 集成测试（含 e2e/ 目录下的 player-loop）
pnpm --filter @mtg-market/api test
```

> 管理员登录用例依赖 `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD`，由 `global-setup.ts` 注入默认值（`admin-e2e@example.test` / `playwright-admin-password-123`）并 seed 进隔离库，一般无需手动设置。

最小启动验证：启动 API 后访问 `http://localhost:3001/health`，应返回 `{"status":"ok","storage":"sqlite-wal"}`；再启动 Web 并打开 `http://localhost:3000`，页面的“服务状态”应显示“API 正常（SQLite WAL）”。

详细职责边界见[技术栈与模块职责边界.md](技术栈与模块职责边界.md)。

开发模式下，`pnpm dev` 会同时启动 API（默认 `http://localhost:3001`）和前端（默认 `http://localhost:3000`）。I33 发布后若启用 AI，AI 模块不单独监听端口：它会由 API 的本地任务循环在比赛结算后调用。
