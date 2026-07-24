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
- `src/platform`：外部服务、存储、安全等可替换技术适配；SQLite schema、迁移和事务工具由 `@mtg-market/database` 提供。
- `src/tests`：测试支撑与分层测试。
- `docs`：架构决策、API 约定和运维手册。
- `data`：运行时持久化数据，不放源码；必须挂载为 Docker 持久化卷。

`@mtg-market/database` 是唯一的 SQLite schema、迁移、连接 pragma、完整性检查和短事务入口。API 的 `src/database.ts` 仅为启动层适配器；各业务模块不得自行建表或执行迁移。迁移在启动、应用开始处理请求和任务前完成；每个迁移在独立 SQLite 事务中原子应用，迁移记录只在同一事务成功后写入。

## HTTP 横切能力（I04）

- `src/app.ts` 是可注入的 Fastify 应用工厂；`server.ts` 只负责组合数据库、任务循环和进程生命周期，集成测试不得监听实际端口。
- 所有 HTTP 成功与失败结果使用 `@mtg-market/contracts` 的统一包络，并通过 `X-Request-Id` 回传请求关联标识。未知路由、Zod 输入校验和未处理异常分别映射为稳定错误码。
- 日志使用 Fastify 内置 Pino，统一脱敏 `Authorization`、Cookie、API key、密码和令牌字段。写路由由横切 hook 记录调用者（I06B 身份接入前为空）、幂等键、路由实体和响应摘要；业务用例仍须在自身事务内写入经济审计事实。
- CORS 仅允许 `CORS_ORIGINS`（未配置时回退为单个 `WEB_ORIGIN`）；不得使用反射式任意 Origin。
- `/health` 提供存活检查，`/ready` 同时检查 SQLite 查询和任务状态摘要。公开协议文档源位于 `src/openapi.ts`，并由集成测试校验公开路由集合。

## 持久化任务（I05）

- `modules/jobs/domain` 定义固定任务类型、状态机和退避；`application` 只编排注册表、启动恢复与处理器调用；`infrastructure` 是唯一能访问 `jobs`/`job_runs` 的 SQLite 仓储。
- worker 每次通过 SQLite 条件更新领取一项任务，并以 `active_run_attempt` 为 `job_runs` 写入全局单调运行记录；手动重试可重置调度尝试计数，但绝不复用不可变历史 attempt。`running` 任务以租约保护；启动时或领取前会关闭过期运行记录并将任务恢复到 `pending`，耗尽尝试次数则转为 `dead`。处理器必须把经济结果设计为幂等，worker 提供的是至少执行一次的调度，不替代业务事实唯一约束。
- 任务按进程串行执行并在优雅关闭时停止新领取、等待在途处理完成。I05 注册的处理器为安全占位符；后续业务迭代必须用对应模块的 application 用例注册替换，不能在 jobs 模块内实现结算。

## 认证与角色（I06B）

- `modules/auth` 持有注册、密码验证、会话轮换、注销和当前会话查询；密码只以 Argon2id 哈希保存，access token 由服务端 HMAC 密钥签发且短期有效，refresh token 仅以 SHA-256 摘要保存在 SQLite。
- refresh token 使用 `HttpOnly; SameSite=Strict; Path=/v1/auth` Cookie；配对的非 HttpOnly CSRF Cookie 必须与 `X-CSRF-Token` 同时通过服务端会话摘要校验，生产环境额外标记 `Secure`。重放已轮换的令牌会撤销其后续轮换链。
- 认证 pre-handler 为请求附加已验证的 actor，并在读取受保护资源时复核会话未撤销、未过期。`requireRole("admin")` 保护全部 `/v1/admin/*` 路由；认证写路由使用单机内存滑动窗口作基础频率限制，部署多实例时必须替换为共享限流实现。

## 存档、账户与账本（I07B）

- `modules/users` 是游戏存档、`GAME_CREDIT` 账户、初始资金与账本查询的唯一入口。`game_archives.user_id` 和 `accounts(user_id, currency)` 均为唯一约束；创建存档会在同一 SQLite 短事务内写入存档、账户、版本化初始资金流水、业务审计及已完成幂等响应。
- 初始资金只通过 `@mtg-market/rules` 的 `initial-funds/v1` 解析；规则定义也保留在 `rule_versions`。账户数据库约束强制 `total = available + frozen` 且三者非负，禁止任何 API 或未来模块直接设置余额。
- `SqliteUserRepository` 暴露 reserve/release/capture 三种共享资金原语。reserve 仅将可用额转入冻结额并附带业务实体关联；release 原样返还；capture 从冻结额扣除总额并写 debit 账本。订单和履约保证金必须由其所属 application 用例在同一短事务中调用。

## Scryfall 目录同步（I09B）

- `platform/external/scryfall` 是唯一可访问 Scryfall Bulk Data 与卡图 URL 的适配器。适配器使用仅服务端可配的自定义 User-Agent，兼容 gzip Bulk 文件，并以对象级扫描避免将完整 Bulk 文件转为 JS 字符串；浏览器目录路由只读取 SQLite，任务下载完成后校验 JSON、启用系列、印刷 ID、工艺与可选 checksum，绝不把 Provider 原文转发给客户端。
- `modules/catalog/application/CatalogSyncService` 先在内存中验证 Bulk 文件和需要缓存的图片，再在一个 SQLite 短事务内替换 `scryfall` 来源的目录行；任何下载、解析、Schema、重复印刷、图片或事务错误都只新增失败运行记录，不删除最近成功目录或其状态指针。
- `catalog_sync_runs` 只追加来源版本、SHA-256、启用系列、导入差异与失败摘要；`catalog_sync_state` 只指向最近成功运行。`catalog.sync` 由 task runner 注册到 catalog application，而不是在 jobs 模块实现业务写入。
- 图片仅能由同步任务写入 `CATALOG_DATA_DIR/images`，文件名由服务端打印 UUID 和受限扩展名产生；`/v1/catalog/images/:imageName` 认证后只提供该目录内的本地文件，拒绝路径穿越和外部图片 URL。

## 管理后台模块边界（计划 I30B）

- `modules/admin` 只编排管理用例与聚合只读查询，不得跨模块直接读写表。用户冻结/解冻和补偿修正调用 users/inventory 等所属模块的 application 命令；活动发布调用 market/application，并通过任务 application 投递版本唯一的 `market.reprice`。
- 活动采用草稿、已排期、已生效、已暂停、已结束的显式状态与实体版本。预览只返回服务端校验结果；发布、暂停和结束是分别审计且要求幂等键的命令，已发布版本不得原地覆盖。
- 玩家管理 API 只提供完成检索、冻结/解冻、会话撤销和补偿修正所需的最小数据；不返回密码哈希、令牌摘要或通用数据库字段，也不提供直接设置最终余额/库存的接口。
- audit/jobs/narratives 等日志由各模块 application 暴露分页、筛选、脱敏查询端口，admin 负责组合 DTO，不访问对方 infrastructure。日志只读，不提供删除/修改路由。
