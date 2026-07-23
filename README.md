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

复制各项目的 `.env.example` 为 `.env.local` 后再填写配置。`OPENAI_API_KEY` 仅在需要启用 AI 叙事时配置在 `apps/ai` 的服务端环境，绝不能发送给浏览器。

详细职责边界见[技术栈与模块职责边界.md](技术栈与模块职责边界.md)。

开发模式下，`pnpm dev` 会同时启动 API（默认 `http://localhost:3001`）和前端（默认 `http://localhost:3000`）。AI 模块不单独监听端口：它会由 API 的本地任务循环在比赛结算后调用。
