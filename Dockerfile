# syntax=docker/dockerfile:1
#
# MTG Market Simulator 单镜像构建。承载 API(Fastify + SQLite) 与 Web(Next.js) 的生产产物，
# 运行时由 docker-compose 用不同 command 分别启动两个进程。单机部署：见 docs/deploy.md。
#
# 安全与边界遵循 AGENTS.md：SQLite 数据为运行时状态，挂卷持久化、绝不烘焙进镜像；
# 服务端密钥由平台环境注入；前端经 Next.js rewrites 反向代理访问 API，不暴露 API 端口。

# ── 阶段 1：安装依赖（含原生模块编译工具链） ──────────────────────────────────
FROM node:22-bookworm-slim AS deps
# better-sqlite3 / argon2 需要 node-gyp 原生编译。
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates wget \
 && rm -rf /var/lib/apt/lists/*
# 锁定 pnpm 版本与仓库一致，避免 corepack 拉取到非预期版本。
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@8.5.1 --activate

WORKDIR /app
# 先只拷贝依赖清单，最大化 layer 缓存命中。
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY apps/ai/package.json apps/ai/
COPY packages/contracts/package.json packages/contracts/
COPY packages/rules/package.json packages/rules/
COPY packages/database/package.json packages/database/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ── 阶段 2：构建全部 workspace 产物 ───────────────────────────────────────────
FROM deps AS build
WORKDIR /app
COPY tsconfig.base.json eslint.config.mjs ./
COPY packages/contracts packages/contracts
COPY packages/rules packages/rules
COPY packages/database packages/database
COPY apps/web apps/web
COPY apps/api apps/api
COPY apps/ai apps/ai
# next start 需要 public 目录存在；仓库可能尚未创建，确保它在。
RUN mkdir -p apps/web/public
# 代理模式：前端以相对路径 /api 访问 API，由 Next rewrites 反向代理到 API 服务。
# 注意：rewrites destination 在构建时固化进 .next；compose 网络内 API 服务名固定为 api。
ENV NEXT_PUBLIC_API_BASE_URL=/api \
    API_PROXY_TARGET=http://api:3001 \
    NODE_ENV=production
RUN pnpm -r build
# 生产依赖裁剪（去掉 devDependencies），保留原生已编译产物。
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm prune --prod

# ── 阶段 3：精简运行时 ───────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runner
# wget 供 compose healthcheck 调用 /health。
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates wget \
 && rm -rf /var/lib/apt/lists/*
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@8.5.1 --activate

WORKDIR /app
ENV NODE_ENV=production \
    APP_ENV=production

# 根 package.json + workspace 清单（pnpm 启动脚本需要）。
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
# 安装好的依赖树（node_modules 含各 workspace 软链 + 原生产物）。
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/ai/node_modules ./apps/ai/node_modules
COPY --from=build /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=build /app/packages/rules/node_modules ./packages/rules/node_modules
COPY --from=build /app/packages/database/node_modules ./packages/database/node_modules

# 共享包产物（API 运行时通过 exports 加载 dist）。
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /app/packages/rules/dist ./packages/rules/dist
COPY --from=build /app/packages/rules/package.json ./packages/rules/package.json
COPY --from=build /app/packages/database/dist ./packages/database/dist
COPY --from=build /app/packages/database/migrations ./packages/database/migrations
COPY --from=build /app/packages/database/package.json ./packages/database/package.json

# API 产物与配置。
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json

# Web 产物（.next + public + 配置，供 next start）。
COPY --from=build /app/apps/web/.next ./apps/web/.next
COPY --from=build /app/apps/web/public ./apps/web/public
COPY --from=build /app/apps/web/next.config.mjs ./apps/web/next.config.mjs
COPY --from=build /app/apps/web/package.json ./apps/web/package.json

# 默认启动 API；Web 由 compose 覆盖 command 为 next start。
EXPOSE 3000 3001
CMD ["node", "apps/api/dist/server.js"]
