# MTG Market Simulator

轻量单机版卡牌市场模拟器 workspace。适用于 5–10 名玩家：本地 SQLite、Scryfall Bulk Data 卡池、MTGJSON 每日价格快照，以及可选 AI 比赛叙事。

## 项目结构

- `apps/web`：Next.js 前端，只负责展示与提交用户意图。
- `apps/api`：Fastify API、本地 SQLite 与持久化任务循环，唯一的经济结算入口。
- `apps/ai`：AI 赛事叙事模块，只输出经过结构校验的文本，不拥有经济系统权限。
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

`apps/api` 与 `apps/ai` 只在启动边界解析其服务器配置；`apps/web` 只允许 `NEXT_PUBLIC_*` 配置。`OPENAI_API_KEY` 仅在需要启用 AI 叙事时配置在 `apps/ai/.env`，绝不能发送给浏览器或写入 `apps/web`。

## 环境与质量门禁

开发环境使用示例中的固定端口：Web 为 `http://localhost:3000`，API 为 `http://localhost:3001`，SQLite 默认写入 `apps/api/data/`。可分别运行 `pnpm dev:web`、`pnpm dev:api` 和 `pnpm dev:ai`；根目录 `pnpm dev` 同时启动 Web 与 API。若端口已被占用，先停止占用进程；不要让 Web 自动换端口，否则它将不再匹配 API 的 `WEB_ORIGIN` CORS 白名单。

测试环境设置 `APP_ENV=test`，并为 API 指定临时 `SQLITE_PATH`，不得复用开发数据库。执行 `pnpm test`、`pnpm check` 与 `pnpm format:check`。测试脚本将临时目录固定为 Linux 的 `/tmp`，避免宿主机路径泄漏到测试运行时。

生产环境设置 `APP_ENV=production`、受限的 `WEB_ORIGIN` 与持久化的绝对 `SQLITE_PATH`；通过 `pnpm build` 生成产物，再分别执行 API 的 `pnpm --filter @mtg-market/api start` 和 AI 的 `pnpm --filter @mtg-market/ai start`。Web 使用 `pnpm --filter @mtg-market/web start`。真实密钥只由部署平台注入，不提交 `.env` 文件。

最小启动验证：启动 API 后访问 `http://localhost:3001/health`，应返回 `{"status":"ok","storage":"sqlite-wal"}`；再启动 Web 并打开 `http://localhost:3000`，页面的“服务状态”应显示“API 正常（SQLite WAL）”。

详细职责边界见[技术栈与模块职责边界.md](技术栈与模块职责边界.md)。

开发模式下，`pnpm dev` 会同时启动 API（默认 `http://localhost:3001`）和前端（默认 `http://localhost:3000`）。AI 模块不单独监听端口：它会由 API 的本地任务循环在比赛结算后调用。
