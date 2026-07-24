# Operations

记录部署、环境配置、数据卷、备份恢复、任务告警、数据同步和故障处理流程。任何涉及经济数据的修复操作必须保留审计证据。

## I04 健康检查

- 容器存活探针调用 `GET /health`；成功只表示 API 进程及其 SQLite 连接可用。
- 流量就绪探针调用 `GET /ready`；只有 SQLite 查询成功时才返回 200，同时响应中的 `jobs` 提供持久化任务状态摘要。返回 503 时不得向该实例分配新流量，先检查结构化日志中的 `requestId` 与数据库可用性。
- `CORS_ORIGINS` 使用逗号分隔的绝对 URL 白名单。生产环境必须显式设置，且不应包含通配符。

## I05 持久化任务处置

- API 启动后先回收租约已过期的 `running` 任务，再串行领取到期的 `pending`/`failed` 任务。正常关闭会停止领取并等待正在执行的处理器返回；非正常中断由下次启动的租约回收处理。
- `GET /v1/admin/jobs` 查询任务，`POST /v1/admin/jobs` 投递去重任务，`POST /v1/admin/jobs/{id}/retry` 仅重试 `failed` 或 `dead`。两个写接口要求 `Idempotency-Key`；I06B 上线前该管理接口只应在受控的内网运维环境使用，随后必须接入 admin RBAC。
- 排障先查看任务的 `last_error` 与 `job_runs` 按 attempt 的运行历史。不要直接修改 `jobs` 状态；确认外部依赖恢复后使用手动重试。租约频繁过期应先检查处理器超时和进程终止原因。

## I09B Scryfall 目录同步

- 首次导入前必须显式设置 `CATALOG_ENABLED_SET_CODES`（英文逗号分隔、系列代码大写）和持久化的 `CATALOG_DATA_DIR`；空系列配置会令任务失败而不会导入完整 Bulk Data。`SCRYFALL_BULK_ENDPOINT` 默认指向 Scryfall `default-cards` 元数据端点，`SCRYFALL_USER_AGENT` 必须标识本服务（建议带运维联系邮箱），两者只允许由 API 进程后台任务访问。Scryfall 会拒绝 Node 默认 User-Agent 并返回 `400 generic_user_agent`。
- 管理员通过 `POST /v1/admin/catalog/sync` 携带 `Idempotency-Key` 投递任务，再以 `GET /v1/admin/catalog/sync` 或通用任务 API 观察状态。排障必须查看 `catalog_sync_runs` 的版本、SHA-256、差异和失败摘要以及 `job_runs`；不得手工删除目录行、图片或修改任务状态。
- 同步会先下载并校验整个 Bulk 文件（兼容 Scryfall 声明的 gzip 编码），以对象级扫描解析顶层数组而不转换完整文件为 JavaScript 字符串，并在读取时只保留启用系列；下载/解析失败最多重试三次、校验未压缩响应长度，再在短事务中替换 Scryfall 来源目录。任何 checksum、JSON 截断、Schema、重复印刷、图片或 SQLite 错误均保留最近成功目录和 `catalog_sync_state` 指针。修复外部问题后使用新的幂等键重新投递；不要将外部 URL 交给浏览器重试。
- 卡图只在任务 payload 明确列出的 Scryfall ID 上下载，并写入 `CATALOG_DATA_DIR/images`。持久化卷必须包含该目录；读取仅通过受保护的本地 `/v1/catalog/images/:imageName` 路径，禁止使用目录路径或 Scryfall 图片 URL 作公开静态根。

## I30B 管理活动与玩家补偿（计划）

以下是 I30B 实现时必须细化为可执行手册的边界；当前尚未实现，不授权通过数据库手工操作替代后台能力。

- 发布活动前保存服务端预览结果，核对活动/预览版本、UTC 生效区间、作用范围、影响上限与冲突。发布、暂停、结束后记录请求 ID、活动版本、审计记录和关联 `market.reprice` 任务；失败或版本冲突时不得直接改活动表或外部价格快照。
- 冻结/解冻玩家、撤销会话或执行余额/库存补偿前，核对用户 ID、当前状态和影响摘要。补偿必须保留原因、原记录关联、幂等键、新流水及审计；禁止设置最终余额/库存、删除旧流水或跨模块直接修表。
- 排障从只读、脱敏日志按请求 ID、操作者、用户、实体或任务关联追踪。日志页面和运维流程都不得显示密码哈希、令牌、Cookie、密钥或敏感 Provider 原文，也不得删除审计记录。
