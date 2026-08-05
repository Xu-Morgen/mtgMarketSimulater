import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isValidIdempotencyKey } from "@mtg-market/contracts";
import { failure, success } from "../../../shared/http/api-response.js";
import { requireRole } from "../../auth/api/auth-routes.js";
import { orderCancelRequestFingerprint, orderCreateRequestFingerprint, orderTradeRequestFingerprint, OrderService, type OrderCommandResult, type TradeCommandResult } from "../application/order-service.js";
import type { ApiConfig } from "../../../config/environment.js";

const skuParams = z.object({ skuId: z.string().uuid() }).strict();
const previewQuery = z.object({ quantity: z.coerce.number().int().min(1).max(1000) }).strict();
const orderIdParams = z.object({ orderId: z.string().uuid() }).strict();
const tradeIdParams = z.object({ tradeId: z.string().uuid() }).strict();
const tradesListQuery = z.object({
  skuId: z.string().uuid().optional(),
  cursor: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20)
}).strict();
const createBody = z.object({
  quoteId: z.string().uuid(),
  quoteVersion: z.string().trim().min(1).max(120),
  previewVersion: z.string().trim().length(64),
  quantity: z.number().int().min(1).max(1000),
  limitPrice: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
}).strict();
const listQuery = z.object({
  status: z.enum(["open", "partially_filled", "matched_pending_fulfillment", "fulfilled", "cancelled", "expired"]).optional(),
  side: z.enum(["buy", "sell"]).optional(),
  cursor: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20)
}).strict();
const riskListQuery = z.object({ outcome: z.enum(["blocked", "flagged"]).optional(), cursor: z.string().regex(/^\d+$/).optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }).strict();

/**
 * 双边委托 HTTP 边界。只验证意图与幂等键；限价带、费用、保证金、额度与预占/释放
 * 均由 OrderService 在经济短事务内决定，浏览器不得自报金额或保证金。
 */
export async function registerOrderRoutes(app: FastifyInstance, database: Database.Database, config: Pick<ApiConfig, "APP_TIMEZONE">): Promise<void> {
  const orders = new OrderService(database, config.APP_TIMEZONE);

  app.get("/v1/orders/buy/:skuId/preview", { preHandler: requireRole("player") }, async (request, reply) => {
    const preview = orders.preview(request.actor!.id, skuParams.parse(request.params).skuId, "buy", previewQuery.parse(request.query).quantity);
    return resolvePreview(request, reply, preview);
  });
  app.get("/v1/orders/sell/:skuId/preview", { preHandler: requireRole("player") }, async (request, reply) => {
    const preview = orders.preview(request.actor!.id, skuParams.parse(request.params).skuId, "sell", previewQuery.parse(request.query).quantity);
    return resolvePreview(request, reply, preview);
  });

  app.post("/v1/orders/buy/:skuId", { preHandler: requireRole("player") }, async (request, reply) => {
    const { skuId } = skuParams.parse(request.params);
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !isValidIdempotencyKey(key)) return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带格式正确的 Idempotency-Key"));
    const body = createBody.parse(request.body);
    const result = orders.create({ userId: request.actor!.id, skuId, side: "buy", idempotencyKey: key, requestFingerprint: orderCreateRequestFingerprint({ ...body, skuId, side: "buy" }), requestId: request.requestId, ...body });
    await triggerMatchAfterCreate(orders, result, skuId, request.requestId, request.log);
    return resolveCommand(request, reply, result);
  });
  app.post("/v1/orders/sell/:skuId", { preHandler: requireRole("player") }, async (request, reply) => {
    const { skuId } = skuParams.parse(request.params);
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !isValidIdempotencyKey(key)) return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带格式正确的 Idempotency-Key"));
    const body = createBody.parse(request.body);
    const result = orders.create({ userId: request.actor!.id, skuId, side: "sell", idempotencyKey: key, requestFingerprint: orderCreateRequestFingerprint({ ...body, skuId, side: "sell" }), requestId: request.requestId, ...body });
    await triggerMatchAfterCreate(orders, result, skuId, request.requestId, request.log);
    return resolveCommand(request, reply, result);
  });

  app.get("/v1/orders", { preHandler: requireRole("player") }, async (request) => {
    const query = listQuery.parse(request.query);
    const filters: Parameters<OrderService["list"]>[1] = { limit: query.limit };
    if (query.status) filters.status = [query.status];
    if (query.side) filters.side = query.side;
    if (query.cursor) filters.cursor = query.cursor;
    return success(request.requestId, orders.list(request.actor!.id, filters));
  });
  // I19F 玩家视角成交只读查询；脱敏对手身份，附玩家角色与待履约资产。纯读、无幂等键、无审计。
  app.get("/v1/orders/trades", { preHandler: requireRole("player") }, async (request) => {
    const query = tradesListQuery.parse(request.query);
    const filters: Parameters<OrderService["listPlayerTrades"]>[1] = { limit: query.limit };
    if (query.skuId) filters.skuId = query.skuId;
    if (query.cursor) filters.cursor = query.cursor;
    return success(request.requestId, orders.listPlayerTrades(request.actor!.id, filters));
  });
  app.get("/v1/orders/:orderId", { preHandler: requireRole("player") }, async (request, reply) => {
    const order = orders.find(request.actor!.id, orderIdParams.parse(request.params).orderId);
    return order ? success(request.requestId, { order }) : reply.code(404).send(failure(request.requestId, "RESOURCE_NOT_FOUND", "未找到该委托"));
  });
  app.post("/v1/orders/:orderId/cancel", { preHandler: requireRole("player") }, async (request, reply) => {
    const orderId = orderIdParams.parse(request.params).orderId;
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !isValidIdempotencyKey(key)) return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带格式正确的 Idempotency-Key"));
    const result = orders.cancel({ userId: request.actor!.id, orderId, idempotencyKey: key, requestFingerprint: orderCancelRequestFingerprint({ orderId }), requestId: request.requestId });
    return resolveCommand(request, reply, result);
  });
  app.get("/v1/orders/book/:skuId", { preHandler: requireRole("player") }, async (request) => {
    const book = orders.book(skuParams.parse(request.params).skuId);
    return success(request.requestId, { book });
  });
  // I21B 管理员只读人工复核入口：只暴露风控理由、评分、规则版本和关联订单，不提供放行或资产修改命令。
  app.get("/v1/admin/orders/risk-decisions", { preHandler: requireRole("admin") }, async (request) => {
    const query = riskListQuery.parse(request.query);
    const filters: Parameters<OrderService["listRiskDecisions"]>[0] = { limit: query.limit };
    if (query.outcome) filters.outcome = query.outcome;
    if (query.cursor) filters.cursor = query.cursor;
    return success(request.requestId, orders.listRiskDecisions(filters));
  });
  // I19B 运维/测试显式触发撮合；admin 角色保护，撮合结果不含其他玩家敏感字段。
  app.post("/v1/orders/:skuId/match", { preHandler: requireRole("admin") }, async (request) => {
    const skuId = skuParams.parse(request.params).skuId;
    const match = orders.match({ skuId, requestId: request.requestId });
    return success(request.requestId, { match });
  });
  // I20B 确认履约：买卖任一方均可发起；请求体为空，幂等键指纹仅依赖路径。
  app.post("/v1/orders/trades/:tradeId/fulfill", { preHandler: requireRole("player") }, async (request, reply) => {
    const tradeId = tradeIdParams.parse(request.params).tradeId;
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !isValidIdempotencyKey(key)) return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带格式正确的 Idempotency-Key"));
    const result = orders.fulfill({ userId: request.actor!.id, tradeId, idempotencyKey: key, requestFingerprint: orderTradeRequestFingerprint({ tradeId, action: "fulfill" }), requestId: request.requestId });
    return resolveTradeCommand(request, reply, result);
  });
  // I20B 取消履约：买卖任一方均可发起；请求体为空，幂等键指纹仅依赖路径。
  app.post("/v1/orders/trades/:tradeId/cancel", { preHandler: requireRole("player") }, async (request, reply) => {
    const tradeId = tradeIdParams.parse(request.params).tradeId;
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !isValidIdempotencyKey(key)) return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带格式正确的 Idempotency-Key"));
    const result = orders.cancelTrade({ userId: request.actor!.id, tradeId, idempotencyKey: key, requestFingerprint: orderTradeRequestFingerprint({ tradeId, action: "cancel" }), requestId: request.requestId });
    return resolveTradeCommand(request, reply, result);
  });
  // I20B 运维/测试显式触发到期回收（委托或成交）；admin 角色保护，幂等。
  app.post("/v1/orders/trades/:tradeId/expire", { preHandler: requireRole("admin") }, async (request) => {
    const tradeId = tradeIdParams.parse(request.params).tradeId;
    orders.expireTrade(tradeId);
    return success(request.requestId, { tradeId, expired: true });
  });
}

/** 统一处理履约/取消履约幂等命令的三种状态（与 resolveCommand 语义一致）。 */
async function resolveTradeCommand(request: { requestId: string }, reply: { code: (code: number) => { send: (body: unknown) => void } }, result: TradeCommandResult) {
  if (result.state === "conflict") return reply.code(409).send(failure(request.requestId, "IDEMPOTENCY_CONFLICT", "Idempotency-Key 已用于不同请求"));
  if (result.state === "in-progress") return reply.code(409).send(failure(request.requestId, "IDEMPOTENCY_IN_PROGRESS", "相同请求正在处理中"));
  return reply.code(result.state === "replayed" && result.response.ok ? 200 : result.statusCode).send(result.response);
}

/** 把预览结果映射为 HTTP 响应；限价带、费用与预览版本完全来自服务端。 */
async function resolvePreview(request: { requestId: string }, reply: { code: (code: number) => { send: (body: unknown) => void } }, preview: Awaited<ReturnType<OrderService["preview"]>>) {
  if (preview === "quote-unavailable") return reply.code(404).send(failure(request.requestId, "PRICE_UNAVAILABLE", "该 SKU 暂无可结算报价"));
  if (preview === "quote-stale") return reply.code(409).send(failure(request.requestId, "VERSION_STALE", "报价已过期，请等待服务端刷新报价"));
  return success(request.requestId, { preview });
}

/** 统一处理幂等命令的三种状态：冲突、进行中、已完成/重放。成功重放返回 200，首次完成返回 201。 */
async function resolveCommand(request: { requestId: string }, reply: { code: (code: number) => { send: (body: unknown) => void } }, result: OrderCommandResult) {
  if (result.state === "conflict") return reply.code(409).send(failure(request.requestId, "IDEMPOTENCY_CONFLICT", "Idempotency-Key 已用于不同请求"));
  if (result.state === "in-progress") return reply.code(409).send(failure(request.requestId, "IDEMPOTENCY_IN_PROGRESS", "相同请求正在处理中"));
  return reply.code(result.state === "replayed" && result.response.ok ? 200 : result.statusCode).send(result.response);
}

/**
 * 创建成功后即时撮合。撮合在独立短事务执行，失败只记日志、不影响委托创建结果；
 * 并发撮合由 SQLite 短事务串行 + bilateral_trades 唯一约束保证不重复成交。
 */
async function triggerMatchAfterCreate(orders: OrderService, result: OrderCommandResult, skuId: string, requestId: string, log: { warn: (message: string) => void }): Promise<void> {
  if (result.state !== "completed" || !result.response.ok) return;
  try {
    orders.match({ skuId, requestId });
  } catch (error) {
    log.warn(`创建后撮合失败，委托已创建；运维可经 admin 端点重跑：${error instanceof Error ? error.message : String(error)}`);
  }
}
