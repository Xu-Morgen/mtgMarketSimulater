/**
 * I04 的最小 OpenAPI 文档源。端点实现新增或变更时必须在此同步；测试会校验文档的
 * 基本结构及公开路由集合，防止 HTTP 协议只存在于实现中。
 */
export const publicApiPaths = ["/health", "/ready", "/openapi.json", "/v1/market/quote-preview", "/v1/auth/register", "/v1/auth/login", "/v1/auth/refresh", "/v1/auth/logout", "/v1/auth/session", "/v1/archive", "/v1/account", "/v1/ledger", "/v1/catalog/cards", "/v1/catalog/cards/{skuId}", "/v1/admin/jobs", "/v1/admin/jobs/{id}/retry"] as const;

export const openApiDocument = {
  openapi: "3.1.0",
  info: { title: "MTG Market Simulator API", version: "v1" },
  paths: {
    "/health": { get: { summary: "存活检查", responses: { "200": { description: "服务存活" } } } },
    "/ready": { get: { summary: "就绪检查", responses: { "200": { description: "依赖可用" }, "503": { description: "依赖不可用" } } } },
    "/openapi.json": { get: { summary: "OpenAPI 3.1 文档", responses: { "200": { description: "API 协议文档" } } } },
    "/v1/market/quote-preview": {
      get: { summary: "NPC 报价规则预览", responses: { "200": { description: "报价预览" }, "400": { description: "参数校验失败" } } }
    },
    "/v1/auth/register": { post: { summary: "注册玩家账户并创建会话", responses: { "201": { description: "已注册" }, "409": { description: "邮箱已存在" }, "429": { description: "认证频率受限" } } } },
    "/v1/auth/login": { post: { summary: "登录并创建会话", responses: { "200": { description: "已登录" }, "401": { description: "凭据无效" }, "429": { description: "认证频率受限" } } } },
    "/v1/auth/refresh": { post: { summary: "轮换 refresh token", responses: { "200": { description: "会话已轮换" }, "401": { description: "令牌无效或重放" }, "403": { description: "CSRF 校验失败" } } } },
    "/v1/auth/logout": { post: { summary: "撤销当前 refresh token", responses: { "200": { description: "已登出" }, "403": { description: "CSRF 校验失败" } } } },
    "/v1/auth/session": { get: { summary: "查询当前 access token 会话", responses: { "200": { description: "当前用户" }, "401": { description: "认证无效或过期" } } } },
    "/v1/archive": {
      post: { summary: "创建唯一游戏存档并发放初始资金", responses: { "201": { description: "存档已创建或幂等重放" }, "400": { description: "缺少幂等键" }, "409": { description: "幂等冲突或处理中" } } },
      get: { summary: "查询当前用户的存档摘要与净资产占位", responses: { "200": { description: "存档摘要" }, "404": { description: "尚未创建存档" } } }
    },
    "/v1/account": { get: { summary: "查询账户总额、可用额与冻结额", responses: { "200": { description: "余额" }, "404": { description: "尚未创建账户" } } } },
    "/v1/ledger": { get: { summary: "分页查询当前用户不可变账本流水", responses: { "200": { description: "账本分页" } } } },
    "/v1/catalog/cards": { get: { summary: "按印刷 SKU 分页查询本地卡牌目录", responses: { "200": { description: "目录分页" }, "401": { description: "认证无效或过期" } } } },
    "/v1/catalog/cards/{skuId}": { get: { summary: "查询单个印刷 SKU 的目录详情", responses: { "200": { description: "SKU 详情" }, "404": { description: "SKU 不存在" } } } },
    "/v1/admin/jobs": {
      get: { summary: "管理任务查询", responses: { "200": { description: "任务列表" } } },
      post: { summary: "投递管理任务", responses: { "201": { description: "任务已投递或去重返回" }, "400": { description: "缺少幂等键或参数无效" } } }
    },
    "/v1/admin/jobs/{id}/retry": {
      post: { summary: "手动重试失败或死亡任务", responses: { "200": { description: "任务已重新排队" }, "409": { description: "状态不可重试" } } }
    }
  }
} as const;
