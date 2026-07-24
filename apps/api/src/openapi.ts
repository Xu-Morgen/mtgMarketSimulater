/**
 * I04 的最小 OpenAPI 文档源。端点实现新增或变更时必须在此同步；测试会校验文档的
 * 基本结构及公开路由集合，防止 HTTP 协议只存在于实现中。
 */
export const publicApiPaths = ["/health", "/ready", "/openapi.json", "/v1/market/quote-preview"] as const;

export const openApiDocument = {
  openapi: "3.1.0",
  info: { title: "MTG Market Simulator API", version: "v1" },
  paths: {
    "/health": { get: { summary: "存活检查", responses: { "200": { description: "服务存活" } } } },
    "/ready": { get: { summary: "就绪检查", responses: { "200": { description: "依赖可用" }, "503": { description: "依赖不可用" } } } },
    "/openapi.json": { get: { summary: "OpenAPI 3.1 文档", responses: { "200": { description: "API 协议文档" } } } },
    "/v1/market/quote-preview": {
      get: { summary: "NPC 报价规则预览", responses: { "200": { description: "报价预览" }, "400": { description: "参数校验失败" } } }
    }
  }
} as const;
