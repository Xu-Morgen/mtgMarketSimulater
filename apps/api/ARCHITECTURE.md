# API 项目架构

本目录承载 Fastify API 与单进程后台任务循环，是余额、库存、订单、开包和比赛结算的唯一写入端。项目采用模块化单体；模块在同一进程和 SQLite 数据库中运行，但源码依赖必须保持单向。

## 分层与依赖

```text
api (HTTP / OpenAPI) → application (用例、事务编排) → domain (规则、模型、不变量)
                                             ↓
                                  infrastructure (SQLite、外部服务、文件)
```

- `api` 只处理鉴权、输入输出 DTO、幂等键和 HTTP 状态；不得写 SQL 或经济规则。
- `application` 是唯一的用例入口，负责短事务、授权、调用领域规则与审计事件。
- `domain` 不依赖 Fastify、SQLite、环境变量或外部 SDK；跨业务计算优先调用 `@mtg-market/rules`。
- `infrastructure` 实现仓储、外部数据源与适配器；不得承载业务决策。
- 模块之间通过对方 `application` 暴露的查询/命令接口或 `contracts` 事件协作，禁止跨模块访问数据库表或基础设施实现。

## 目录约定

- `src/bootstrap`：进程组合、生命周期和路由注册。
- `src/config`：环境变量解析和受版本控制的运行配置。
- `src/shared`：跨模块的技术性通用能力，不放业务概念。
- `src/modules`：按业务能力划分的垂直模块。
- `src/platform`：SQLite、外部服务、存储、安全等可替换技术适配。
- `src/tests`：测试支撑与分层测试。
- `docs`：架构决策、API 约定和运维手册。
- `data`：运行时持久化数据，不放源码；必须挂载为 Docker 持久化卷。

现有 `src/server.ts`、`src/database.ts` 和 `src/task-runner.ts` 是当前最小启动实现。本次不迁移或改写代码；后续开发时按上述边界逐步收敛。
