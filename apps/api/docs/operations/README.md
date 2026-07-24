# Operations

记录部署、环境配置、数据卷、备份恢复、任务告警、数据同步和故障处理流程。任何涉及经济数据的修复操作必须保留审计证据。

## I04 健康检查

- 容器存活探针调用 `GET /health`；成功只表示 API 进程及其 SQLite 连接可用。
- 流量就绪探针调用 `GET /ready`；只有 SQLite 查询成功时才返回 200，同时响应中的 `jobs` 提供持久化任务状态摘要。返回 503 时不得向该实例分配新流量，先检查结构化日志中的 `requestId` 与数据库可用性。
- `CORS_ORIGINS` 使用逗号分隔的绝对 URL 白名单。生产环境必须显式设置，且不应包含通配符。

## I05 持久化任务处置

- API 启动后先回收租约已过期的 `running` 任务，再串行领取到期的 `pending`/`failed` 任务。正常关闭会停止领取并等待正在执行的处理器返回；非正常中断由下次启动的租约回收处理。
- `GET /v1/admin/jobs` 查询任务，`POST /v1/admin/jobs` 投递去重任务，`POST /v1/admin/jobs/{id}/retry` 仅重试 `failed` 或 `dead`。两个写接口要求 `Idempotency-Key`；I06 上线前该管理接口只应在受控的内网运维环境使用，随后必须接入 admin RBAC。
- 排障先查看任务的 `last_error` 与 `job_runs` 按 attempt 的运行历史。不要直接修改 `jobs` 状态；确认外部依赖恢复后使用手动重试。租约频繁过期应先检查处理器超时和进程终止原因。
