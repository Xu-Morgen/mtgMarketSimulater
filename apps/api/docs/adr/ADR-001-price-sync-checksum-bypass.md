# ADR-001：价格同步 checksum 覆写必须是受条件限制的审计任务

日期：2026-07-26

状态：已采纳

## 背景

MTGJSON 的内容文件和 `.sha256` 侧车可能因上游 CDN 缓存版本不一致而短暂不匹配。严格校验会安全拒绝同步，但管理员可能需要在确认风险后使用已经下载的价格数据。

## 决定

- 默认路径始终强制校验两份文件的 SHA-256。
- 仅当最近一次运行持久化为 `CHECKSUM_MISMATCH` 时，`admin` 可经确认提交 `{ "allowChecksumMismatch": true }`；其他时间返回 `409 RESOURCE_CONFLICT`。
- 覆写是与普通刷新分离的幂等意图，成功运行在 `price_sync_runs.checksum_verification` 中标记为 `bypassed`，实际下载的 SHA-256 仍会保存。
- 覆写请求以任务 ID 唯一写入不可变 `price_sync.checksum_bypass_requested` 审计事实；浏览器不接触 Provider 文件或校验和比较逻辑。

## 后果

管理员可在受控场景下恢复价格同步，但必须承担未验证上游输入的风险。玩家公开 DTO 不暴露覆写原因或 Provider 详情；运维可通过管理状态、任务、运行记录和审计日志追溯该决定。
