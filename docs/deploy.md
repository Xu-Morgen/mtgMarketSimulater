# MTG Market Simulator 云服务器部署指南

面向 Ubuntu LTS + Docker Compose 的单机部署。适用于 5–10 名玩家、SQLite 本地存储、无外部数据库/缓存。

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
| `WEB_ORIGIN` | 改为你的实际访问地址（如 `https://your-domain.com`） |
| `CORS_ORIGINS` | 与 `WEB_ORIGIN` 一致（代理模式下浏览器同源） |
| `SCRYFALL_USER_AGENT` | 替换 contact 中的邮箱（Scryfall 拒绝 Node 默认 UA） |
| `MTGJSON_USER_AGENT` | 同上 |

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
```

## 4. 验证

```bash
# API 健康检查（容器内可达）
docker compose exec api wget -qO- http://localhost:3001/health

# 应返回：{"ok":true,"data":{"status":"ok","database":{"status":"ok","storage":"sqlite-wal"}},...}

# Web 首页（宿主机）
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/
# 应返回：200

# 前端代理（浏览器访问 http://<服务器IP>:3000 后页面"服务状态"应显示"API 正常（SQLite WAL）"）
```

## 5. 运维

### 查看服务状态
```bash
docker compose ps
```

### 重启服务
```bash
docker compose restart
```

### 手动触发卡池/价格同步
```bash
# 同步任务由 API 后台自动调度；如需手动触发，进入 API 容器：
docker compose exec api node -e "
  import { fileURLToPath } from 'node:url';
  import { config as loadDotenv } from 'dotenv';
  loadDotenv({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
  import { loadApiConfig } from './config/environment.js';
  import { openDatabase } from './database.js';
  import { createApiApp } from './app.js';
  const env = loadApiConfig(process.env);
  const db = openDatabase(env.SQLITE_PATH);
  // 手动插入同步任务记录，后台 runner 会自动拾取
  db.prepare('INSERT INTO jobs (type, status, scheduled_at) VALUES (?, ?, datetime(\"now\"))').run('catalog.sync', 'pending');
  db.close();
"
```

### 备份 SQLite 数据
```bash
# 创建备份（API 容器内执行，确保 WAL 一致性）
docker compose exec api node -e "
  import 'dotenv/config';
  import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
  import { openDatabase } from './database.js';
  const env = require('./config/environment.js').loadApiConfig(process.env);
  const db = openDatabase(env.SQLITE_PATH);
  // SQLite WAL checkpoint 确保所有数据写入主文件
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  console.log('Checkpoint done, data/ 目录可安全备份');
"
# 备份卷数据
docker cp $(docker compose ps -q api):/app/data ./backup-$(date +%Y%m%d)
```

### 升级（拉取新代码后重建）
```bash
git pull
docker compose build
docker compose up -d
```

## 6. 安全提示

- **密钥只存于服务器的 `.env.docker`，绝不提交仓库。** `.gitignore` 已排除 `.env.docker`。
- API 服务仅在 Docker 内部网络暴露（`expose 3001`，不 `ports`），外部只能通过 Web 的 `/api` 代理访问。
- 如需 HTTPS：在 Web 前面放 Nginx/Caddy 反代，或使用云厂商负载均衡，将 443 转到宿主机 3000。
- AI 叙事模块（I33 后）的 `OPENAI_API_KEY` 仅配置在 `apps/ai/.env`，不可放入 `.env.docker` 或浏览器环境。
- 定期备份 `api-data` 卷中的 SQLite 数据库。
