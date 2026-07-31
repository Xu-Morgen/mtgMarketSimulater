# MTG Market Simulator 云服务器部署指南

面向 Ubuntu LTS + Docker Compose 的单机部署。适用于 5–10 名玩家、SQLite 本地存储、无外部数据库/缓存。

## 0. 架构总览

三个 Docker 服务，共享同一应用镜像：

| 服务 | 职责 | 端口 |
|------|------|------|
| `caddy` | 唯一对外入口，反代到 `web:3000`；有域名时自动 HTTPS | 80 / 443 |
| `web` | Next.js 生产服务，经 rewrites 反向代理 `/api` → `api:3001` | 容器内 3000 |
| `api` | Fastify + SQLite，唯一经济结算入口 | 容器内 3001 |

API 与 Web 不直接对外暴露端口；所有外部流量经 Caddy 进入。SQLite、卡池、备份与导出持久化到命名卷 `api-data`。

## 1. 服务器选型与初始化

### 硬件建议
| 项 | 最低配置 | 推荐配置 |
|----|---------|---------|
| CPU | 1 核 | 2 核 |
| 内存 | 2 GB | 4 GB（Next.js 构建消耗内存） |
| 磁盘 | 20 GB SSD | 40 GB SSD（卡池图片/备份） |
| 系统 | Ubuntu 22.04 LTS | Ubuntu 24.04 LTS |

### 安装 Docker

```bash
# 安装 Docker Engine + Compose 插件（Ubuntu 官方文档）
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
docker compose version   # 确认可用
```

## 2. 拉取仓库并准备配置

```bash
git clone https://github.com/Xu-Morgen/mtgMarketSimulater.git
cd mtgMarketSimulater
```

### 生成密钥

```bash
# AUTH_JWT_SECRET：至少 32 字符的随机字符串
openssl rand -base64 32

# DECK_RESPONSE_ENCRYPTION_KEY：32 字节 base64（openssl rand -base64 32 恰好 32 字节）
openssl rand -base64 32
```

### 创建环境文件

```bash
cp .env.docker.example .env.docker
```

编辑 `.env.docker`，**必须替换以下项**：

| 变量 | 说明 |
|------|------|
| `AUTH_JWT_SECRET` | 填入上面生成的 JWT 密钥（示例值会被 zod 拒绝） |
| `DECK_RESPONSE_ENCRYPTION_KEY` | 填入上面生成的加密密钥（默认值在生产环境被拒绝） |
| `WEB_ORIGIN` | 改为你的实际访问地址（如 `https://your-domain.com`，无域名用 `http://服务器IP`） |
| `CORS_ORIGINS` | 与 `WEB_ORIGIN` 一致（代理模式下浏览器同源） |
| `SCRYFALL_USER_AGENT` | 替换 contact 中的邮箱（Scryfall 拒绝 Node 默认 UA） |
| `MTGJSON_USER_AGENT` | 同上 |
| `DOMAIN`（可选） | 有域名时设为 `your-domain.com`，Caddy 自动签发 HTTPS 证书；留空走纯 HTTP |
| `WEB_PORT`（可选） | Caddy 对外 HTTP 端口，默认 80；HTTPS 固定 443 |

备份与导出相关变量（`BACKUP_DIR`/`EXPORT_DIR` 等）默认指向 `/app/data` 持久卷，通常无需修改。

## 3. 构建与启动

```bash
docker compose build
docker compose up -d
```

首次启动后 API 会自动创建 SQLite 数据库并执行全部迁移。查看日志：

```bash
# 实时日志
docker compose logs -f

# 仅 API
docker compose logs -f api

# 仅 Web
docker compose logs -f web

# 仅 Caddy
docker compose logs -f caddy
```

## 4. 验证

```bash
# API 健康检查（容器内可达）
docker compose exec api wget -qO- http://localhost:3001/health

# 应返回：{"ok":true,"data":{"status":"ok","database":{"status":"ok","storage":"sqlite-wal"}},...}

# Web 首页（经 Caddy 对外入口）
curl -s -o /dev/null -w "%{http_code}" http://localhost/
# 应返回：200

# 浏览器访问 http://<服务器IP>（有域名则 https://your-domain.com），
# 页面"服务状态"应显示"API 正常（SQLite WAL）"
```

## 5. 备份、恢复与导出（I31B）

系统每日自动以 UTC 自然日为唯一键投递一次 `backup.create`，产出 WAL 一致副本并做完整性校验；默认保留 7 份成功备份，超出部分清理最旧，**永不删最近成功备份**。

### 手动触发备份（管理员）
后台任务每日自动备份；如需手动触发，通过管理 API（需 admin token + Idempotency-Key）：

```bash
curl -X POST http://localhost/v1/admin/backups \
  -H "Authorization: Bearer <ADMIN_ACCESS_TOKEN>" \
  -H "Idempotency-Key: manual-backup-$(date +%s)"
```

### 恢复演练（只读，绝不覆盖运行库）
```bash
curl -X POST http://localhost/v1/admin/backups/<backupId>/restore-rehearsal \
  -H "Authorization: Bearer <ADMIN_ACCESS_TOKEN>" \
  -H "Idempotency-Key: rehearse-$(date +%s)"
# 返回完整性校验与核心表行数；正式恢复需人工停服替换文件。
```

### 玩家导出
玩家可在前端导出自己的库存/交易/经营报表（CSV/JSON）。CSV 已做公式注入防护；导出严格按用户隔离，越权下载他人文件返回 404。

### 离线卷备份（定期做，更稳妥）
```bash
# WAL checkpoint 确保所有数据写入主文件后复制整个 data 目录
docker compose exec -T api node -e "const d=require('better-sqlite3')('/app/data/market-simulator.db'); d.pragma('wal_checkpoint(TRUNCATE)'); d.close();"
docker cp "$(docker compose ps -q api)":/app/data ./backup-$(date +%Y%m%d)
```

## 6. CI/CD 自动部署（GHCR + SSH）

仓库配置了两条 GitHub Actions 工作流：

- `.github/workflows/ci.yml`：push/PR 时跑 lint、类型检查、测试、构建，并把镜像以 `:<git短sha>` 与 `:latest` 双标签推送到 GHCR（`ghcr.io/xu-morgen/mtgmarketsimulater`）。
- `.github/workflows/deploy.yml`：push 到 `main`（或手动 `workflow_dispatch`）时，SSH 登服务器执行：**预备份（部署前自动 `wal_checkpoint` + 卷拷贝）→ `git pull` + `docker compose pull` + `up -d`（迁移随 API 启动自动跑）→ 轮询 `/ready` 直到 200（最多 90 秒）→ 失败则保留预备份并以非零退出告警**。

### 所需仓库 Secrets（Settings → Secrets and variables → Actions）

| Secret | 用途 |
|--------|------|
| `SSH_PRIVATE_KEY` | 部署用 SSH 私钥（建议为受限部署密钥） |
| `SSH_HOST` | 目标服务器 IP 或域名 |
| `SSH_USER` | SSH 登录用户（需有 docker 权限） |
| `DEPLOY_DIR` | 服务器上 `docker-compose.yml` 所在目录（如 `/opt/mtgMarketSimulater`） |

`GITHUB_TOKEN` 用于 GHCR 登录，由 Actions 自动注入，无需手动配置。部署前请在服务器上完成第 2–3 步的首次初始化（含 `.env.docker` 与密钥），deploy 工作流只做拉取与重启。

### 回滚（deploy 健康检查失败或上线后异常）

1. 切回上一版本镜像（GHCR 保留了每次提交的 `<git短sha>` 标签）：
   ```bash
   cd /opt/mtgMarketSimulater
   # 编辑 docker-compose.yml，把 api/web 的 image 改为上一版本 sha 标签，或：
   docker compose pull ghcr.io/xu-morgen/mtgmarketsimulater:<上一sha>
   docker compose up -d
   ```
2. 若数据需回退到预备份：停服 → 用 `backup-predeploy-*` 目录替换 `/app/data` → 重启。
   ```bash
   docker compose down
   docker cp ./backup-predeploy-YYYYMMDD-HHMMSS/. $(docker create --name api-restore mtg-market-simulator):/app/data/
   docker rm api-restore
   docker compose up -d
   ```
3. 检查日志与健康：`docker compose logs api`、`curl localhost/ready`。

迁移是只追加且向后兼容的，回滚到较旧镜像通常安全；若回滚跨越了破坏性迁移，优先用预备份恢复数据。

## 7. 运维

### 查看服务状态
```bash
docker compose ps
```

### 重启服务
```bash
docker compose restart
```

### 手动触发卡池/价格同步
同步任务由 API 后台自动调度；如需手动触发，进入 API 容器插入同步任务记录，后台 runner 会自动拾取：

```bash
docker compose exec api node -e "const d=require('better-sqlite3')('/app/data/market-simulator.db'); d.prepare(\"INSERT INTO jobs (id, type, status, payload_json, unique_key, run_after, attempts, max_attempts, created_at, updated_at) VALUES (lower(hex(randomblob(16))), 'catalog.sync', 'pending', '{}', 'manual-'||lower(hex(randomblob(8))), datetime('now'), 0, 3, datetime('now'), datetime('now'))\").run(); d.close();"
```

### 升级（手动，不经 CI）
```bash
cd /opt/mtgMarketSimulater
git pull
docker compose build
docker compose up -d
```

数据不会丢（存在持久卷 `api-data` 里）。

## 8. 安全提示

- **密钥只存于服务器的 `.env.docker`，绝不提交仓库。** `.gitignore` 已排除 `.env.docker`。
- API 与 Web 仅在 Docker 内部网络暴露（`expose`，不 `ports`），外部只能通过 Caddy 访问。
- Caddy 在有域名时自动签发并续期 Let's Encrypt 证书；纯 IP 部署走 HTTP，建议加云负载均衡或前置 HTTPS。
- AI 叙事模块（I33 后）的 `OPENAI_API_KEY` 仅配置在 `apps/ai/.env`，不可放入 `.env.docker` 或浏览器环境。
- 定期备份 `api-data` 卷；系统每日自动备份，但离线卷备份更稳妥。

