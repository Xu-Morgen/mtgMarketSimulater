## 修复：隔离 HTTP 导出测试的 EXPORT_DIR

### 改动（单文件，单处）
`apps/api/src/tests/integration/backup-export-routes.test.ts` 第 212-214 行的「通过 HTTP 路由」测试：

- 当前：`const { database } = fixture();` + `const app = await buildApp(database);`
- 改为：解构 `backupDir, exportDir`，并传入 `buildApp(database, { BACKUP_DIR: backupDir, EXPORT_DIR: exportDir })`

这与本文件第 47 行（备份路由测试）已经使用的模式完全一致：该 fixture 已通过 `mkdtempSync` 生成独立临时目录，`afterEach`（第 12 行）已负责清理。HTTP 测试是本文件中唯一既写文件（`POST /v1/exports`）又未隔离 `EXPORT_DIR` 的用例，因此它会命中共享的 cwd 相对路径 `./data/exports`，并在该目录不可写（当前 `root:root 755`）时让记录 `failed` → 路由 500。

### 为什么是确定性 bug 而非偶发
即使单线程，只要 `./data/exports` 不可被运行用户写入，该测试就会稳定复现 500。并发下的 timeout（admin-routes / order-routes）是另一层资源争用表现，不属于本次确定性修复范围。

### 验证
- 运行用户原始命令复现并确认转绿：`TMPDIR=/tmp npx vitest run --passWithNoTests`（在 apps/api 下）
- 单独跑该文件确认仍通过：`npx vitest run src/tests/integration/backup-export-routes.test.ts`

### 不在本次改动范围（仅作记录）
- `apps/api/data/exports/` 当前由 root 所有（应为前置 docker/以 root 运行测试遗留），属环境状态而非代码缺陷；建议本地清理（`sudo rm -rf apps/api/data/exports/*` 或 chown 回运行用户），但不作为本次提交内容。
- 其余并发下偶发 timeout（admin-routes / order-routes）若需根治，需单独评估是否引入 apps/api 的 vitest.config.ts 限制并发，那会掩盖潜在真并发缺陷，故不在本次处理。