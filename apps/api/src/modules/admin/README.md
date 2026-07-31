# Admin Module

I30B 管理后台服务端。四层实现（api/application/domain/infrastructure）提供受 `admin` 角色、版本、幂等与审计保护的日志、活动、玩家和运营配置 API。

- 所有 `/v1/admin/*` 写路由要求格式正确的 `Idempotency-Key`、必填原因（适用时）、实体版本与不可变 `audit_logs` 审计。
- `AdminModule` 只通过 users/inventory/packs/market/catalog/jobs 各模块 application 端口协作，绝不跨模块直写 users/accounts/inventory 等他模块表（用户冻结、会话撤销除外，仅改 users/sessions 行）。
- 补偿只追加账本/库存流水，绝不直接覆盖最终值或删除原流水；活动与补充包规则发布后不可原地覆盖。
- 日志查询服务端分页、脱敏，不返回密码哈希、令牌、Cookie、密钥或 Provider 原始响应，且不提供删除/修改接口。
