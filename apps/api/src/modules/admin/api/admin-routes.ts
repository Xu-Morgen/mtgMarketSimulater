import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isValidIdempotencyKey } from "@mtg-market/contracts";
import type { ApiConfig } from "../../../config/environment.js";
import { failure, success } from "../../../shared/http/api-response.js";
import { requireRole } from "../../auth/api/auth-routes.js";
import { AdminService, type AdminErrorResult, type AdminWriteResult } from "../application/admin-service.js";

/**
 * I30B 管理后台路由。所有路由要求 admin 角色；写路由要求 Idempotency-Key、原因（适用时）、
 * 实体版本与不可变审计。日志与详情只返回脱敏字段。AdminModule 不跨模块直写他模块表。
 */

const idempotencyKeyHeader = (request: { headers: Record<string, string | string[] | undefined> }): string | null => {
  const key = request.headers["idempotency-key"];
  return typeof key === "string" ? key : null;
};

function requireIdempotencyKey(requestId: string, key: string | null): { valid: true } | { valid: false; response: ReturnType<typeof failure> } {
  if (key && isValidIdempotencyKey(key)) return { valid: true };
  return { valid: false, response: failure(requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带格式正确的 Idempotency-Key") };
}

const auditLogQuerySchema = z.object({
  cursor: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  actorId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  entityType: z.string().max(64).optional(),
  entityId: z.string().max(128).optional(),
  action: z.string().max(128).optional(),
  requestId: z.string().max(128).optional(),
  taskType: z.string().max(64).optional()
}).strict();

const userQuerySchema = z.object({
  userId: z.string().uuid().optional(),
  username: z.string().max(128).optional(),
  role: z.enum(["player", "admin"]).optional(),
  status: z.enum(["active", "frozen"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0)
}).strict();

const campaignCreateBodySchema = z.object({
  code: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  campaignType: z.literal("market_factor"),
  scopeType: z.enum(["global", "set", "sku"]),
  scopeId: z.string().trim().max(64).nullable().optional(),
  factorBps: z.number().int().min(5000).max(20000),
  displayText: z.string().trim().min(1).max(500),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  reason: z.string().trim().max(500).nullable().optional()
}).strict();

const publishBodySchema = z.object({ previewVersion: z.number().int().min(1) }).strict();
const freezeBodySchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const compensateBalanceBodySchema = z.object({
  amount: z.number().int().refine((v) => v !== 0, "金额不能为零"),
  direction: z.enum(["credit", "debit"]),
  reason: z.string().trim().min(1).max(500)
}).strict();
const compensateInventoryBodySchema = z.object({
  skuId: z.string().uuid(),
  quantity: z.number().int().refine((v) => v !== 0, "数量不能为零"),
  direction: z.enum(["credit", "debit"]),
  reason: z.string().trim().min(1).max(500)
}).strict();
const marketParametersBodySchema = z.object({
  eurCentToGameCreditBps: z.number().int().min(1).max(1000000),
  minimumPrice: z.number().int().min(0),
  npcBuySpreadBps: z.number().int().min(0).max(9999),
  npcSellSpreadBps: z.number().int().min(0).max(100000),
  npcFeeBps: z.number().int().min(0).max(100000),
  expectedVersion: z.number().int().min(0)
}).strict();
const packRuleBodySchema = z.object({
  version: z.string().trim().min(1).max(64),
  pools: z.array(z.object({
    id: z.string().trim().min(1).max(64),
    rarity: z.string().trim().min(1).max(64),
    candidates: z.array(z.object({ skuId: z.string().uuid(), weight: z.number().int().min(1) })).min(1)
  })).min(1),
  slots: z.array(z.object({
    id: z.string().trim().min(1).max(64),
    draws: z.number().int().min(1),
    poolWeights: z.array(z.object({ poolId: z.string().trim().min(1).max(64), weight: z.number().int().min(1) })).min(1)
  })).min(1)
}).strict();
const disablePackBodySchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const setlistDraftBodySchema = z.object({
  sourceVersion: z.string().trim().min(1).max(64),
  sourceChecksumSha256: z.string().regex(/^[a-f0-9]{64}$/i).nullable().optional(),
  setlist: z.array(z.object({ code: z.string().trim().min(1).max(16), name: z.string().trim().min(1).max(200), releaseDate: z.string().nullable().optional() }))
}).strict();

export async function registerAdminRoutes(app: FastifyInstance, config: ApiConfig, database: Database.Database): Promise<void> {
  const admin = new AdminService(database, { environment: config.APP_ENV });
  const now = () => new Date().toISOString();

  // ----- 后台首页与日志（只读） -----
  app.get("/v1/admin/dashboard", { preHandler: requireRole("admin") }, async (request) =>
    success(request.requestId, admin.dashboard())
  );

  app.get("/v1/admin/audit-logs", { preHandler: requireRole("admin") }, async (request) => {
    const query = auditLogQuerySchema.parse(request.query);
    const page = admin.listAuditLogs(query, query.cursor, query.limit);
    return success(request.requestId, page);
  });

  app.get("/v1/admin/audit-logs/:id", { preHandler: requireRole("admin") }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const log = admin.getAuditLog(id);
    if (!log) return reply.code(404).send(failure(request.requestId, "RESOURCE_NOT_FOUND", "审计日志不存在"));
    return success(request.requestId, { log });
  });

  app.get("/v1/admin/exception-trades", { preHandler: requireRole("admin") }, async (request) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).strict().parse(request.query);
    return success(request.requestId, { items: admin.listExceptionTrades(limit) });
  });

  // ----- 活动 -----
  app.post("/v1/admin/campaigns", { preHandler: requireRole("admin") }, async (request, reply) => {
    const key = idempotencyKeyHeader(request);
    const keyCheck = requireIdempotencyKey(request.requestId, key);
    if (!keyCheck.valid) return reply.code(400).send(keyCheck.response);
    const body = campaignCreateBodySchema.parse(request.body);
    const result = admin.saveCampaignDraft({
      code: body.code, name: body.name, description: body.description ?? null, campaignType: body.campaignType,
      scopeType: body.scopeType, scopeId: body.scopeId ?? null, factorBps: body.factorBps, displayText: body.displayText,
      startsAt: body.startsAt, endsAt: body.endsAt, reason: body.reason ?? null,
      actorId: request.actor!.id, idempotencyKey: key!, requestId: request.requestId, now: now()
    });
    return sendWriteReply(request, reply, result, 201);
  });

  app.get("/v1/admin/campaigns", { preHandler: requireRole("admin") }, async (request) => {
    const { limit, offset } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), offset: z.coerce.number().int().min(0).default(0) }).strict().parse(request.query);
    return success(request.requestId, admin.listCampaigns(limit, offset));
  });

  app.get("/v1/admin/campaigns/:id", { preHandler: requireRole("admin") }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const campaign = admin.getCampaign(id);
    if (!campaign) return reply.code(404).send(failure(request.requestId, "RESOURCE_NOT_FOUND", "活动不存在"));
    return success(request.requestId, { campaign });
  });

  app.post("/v1/admin/campaigns/:id/preview", { preHandler: requireRole("admin") }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = admin.previewCampaign(id, now());
    return sendPreviewResult(request, reply, result);
  });

  app.post("/v1/admin/campaigns/:id/publish", { preHandler: requireRole("admin") }, async (request, reply) => {
    const key = idempotencyKeyHeader(request);
    const keyCheck = requireIdempotencyKey(request.requestId, key);
    if (!keyCheck.valid) return reply.code(400).send(keyCheck.response);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = publishBodySchema.parse(request.body);
    const result = admin.publishCampaign({ campaignId: id, previewVersion: body.previewVersion, actorId: request.actor!.id, idempotencyKey: key!, requestId: request.requestId, now: now() });
    return sendWriteReply(request, reply, result, 200);
  });

  app.post("/v1/admin/campaigns/:id/pause", { preHandler: requireRole("admin") }, async (request, reply) => {
    const key = idempotencyKeyHeader(request);
    const keyCheck = requireIdempotencyKey(request.requestId, key);
    if (!keyCheck.valid) return reply.code(400).send(keyCheck.response);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = admin.pauseCampaign({ campaignId: id, actorId: request.actor!.id, idempotencyKey: key!, requestId: request.requestId, now: now() });
    return sendWriteReply(request, reply, result, 200);
  });

  app.post("/v1/admin/campaigns/:id/end", { preHandler: requireRole("admin") }, async (request, reply) => {
    const key = idempotencyKeyHeader(request);
    const keyCheck = requireIdempotencyKey(request.requestId, key);
    if (!keyCheck.valid) return reply.code(400).send(keyCheck.response);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = admin.endCampaign({ campaignId: id, actorId: request.actor!.id, idempotencyKey: key!, requestId: request.requestId, now: now() });
    return sendWriteReply(request, reply, result, 200);
  });

  // ----- 用户管理 -----
  app.get("/v1/admin/users", { preHandler: requireRole("admin") }, async (request) => {
    const query = userQuerySchema.parse(request.query);
    return success(request.requestId, admin.searchUsers(query, query.limit, query.offset));
  });

  app.get("/v1/admin/users/:id", { preHandler: requireRole("admin") }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const user = admin.getUserDetail(id);
    if (!user) return reply.code(404).send(failure(request.requestId, "RESOURCE_NOT_FOUND", "用户不存在"));
    return success(request.requestId, { user });
  });

  app.post("/v1/admin/users/:id/freeze", { preHandler: requireRole("admin") }, async (request, reply) => {
    const key = idempotencyKeyHeader(request);
    const keyCheck = requireIdempotencyKey(request.requestId, key);
    if (!keyCheck.valid) return reply.code(400).send(keyCheck.response);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = freezeBodySchema.parse(request.body);
    const result = admin.freezeUser({ userId: id, reason: body.reason, actorId: request.actor!.id, idempotencyKey: key!, requestId: request.requestId, now: now() });
    return sendWriteReply(request, reply, result, 200);
  });

  app.post("/v1/admin/users/:id/unfreeze", { preHandler: requireRole("admin") }, async (request, reply) => {
    const key = idempotencyKeyHeader(request);
    const keyCheck = requireIdempotencyKey(request.requestId, key);
    if (!keyCheck.valid) return reply.code(400).send(keyCheck.response);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = admin.unfreezeUser({ userId: id, actorId: request.actor!.id, idempotencyKey: key!, requestId: request.requestId, now: now() });
    return sendWriteReply(request, reply, result, 200);
  });

  app.post("/v1/admin/users/:id/revoke-sessions", { preHandler: requireRole("admin") }, async (request, reply) => {
    const key = idempotencyKeyHeader(request);
    const keyCheck = requireIdempotencyKey(request.requestId, key);
    if (!keyCheck.valid) return reply.code(400).send(keyCheck.response);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = admin.revokeUserSessions({ userId: id, actorId: request.actor!.id, idempotencyKey: key!, requestId: request.requestId, now: now() });
    return sendWriteReply(request, reply, result, 200);
  });

  app.post("/v1/admin/users/:id/compensate/balance", { preHandler: requireRole("admin") }, async (request, reply) => {
    const key = idempotencyKeyHeader(request);
    const keyCheck = requireIdempotencyKey(request.requestId, key);
    if (!keyCheck.valid) return reply.code(400).send(keyCheck.response);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = compensateBalanceBodySchema.parse(request.body);
    const result = admin.compensateBalance({ userId: id, amount: body.amount, direction: body.direction, reason: body.reason, actorId: request.actor!.id, idempotencyKey: key!, requestId: request.requestId, now: now() });
    return sendWriteReply(request, reply, result, 200);
  });

  app.post("/v1/admin/users/:id/compensate/inventory", { preHandler: requireRole("admin") }, async (request, reply) => {
    const key = idempotencyKeyHeader(request);
    const keyCheck = requireIdempotencyKey(request.requestId, key);
    if (!keyCheck.valid) return reply.code(400).send(keyCheck.response);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = compensateInventoryBodySchema.parse(request.body);
    const result = admin.compensateInventory({ userId: id, skuId: body.skuId, quantity: body.quantity, direction: body.direction, reason: body.reason, actorId: request.actor!.id, idempotencyKey: key!, requestId: request.requestId, now: now() });
    return sendWriteReply(request, reply, result, 200);
  });

  // ----- 市场参数 -----
  app.get("/v1/admin/market-parameters", { preHandler: requireRole("admin") }, async (request, reply) => {
    const params = admin.getMarketParameters();
    if (!params) return reply.code(404).send(failure(request.requestId, "RESOURCE_NOT_FOUND", "市场参数未初始化"));
    return success(request.requestId, params);
  });

  app.post("/v1/admin/market-parameters", { preHandler: requireRole("admin") }, async (request, reply) => {
    const key = idempotencyKeyHeader(request);
    const keyCheck = requireIdempotencyKey(request.requestId, key);
    if (!keyCheck.valid) return reply.code(400).send(keyCheck.response);
    const body = marketParametersBodySchema.parse(request.body);
    const result = admin.updateMarketParameters({ ...body, actorId: request.actor!.id, idempotencyKey: key!, requestId: request.requestId, now: now() });
    return sendWriteReply(request, reply, result, 200);
  });

  // ----- 系列/SKU 启停与同步触发 -----
  app.get("/v1/admin/catalog/series", { preHandler: requireRole("admin") }, async (request) =>
    success(request.requestId, { items: admin.listSeries() })
  );

  app.post("/v1/admin/catalog/skus/:id/tradable", { preHandler: requireRole("admin") }, async (request, reply) => {
    const key = idempotencyKeyHeader(request);
    const keyCheck = requireIdempotencyKey(request.requestId, key);
    if (!keyCheck.valid) return reply.code(400).send(keyCheck.response);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ tradable: z.boolean() }).strict().parse(request.body);
    const result = admin.setSkuTradable({ skuId: id, tradable: body.tradable, actorId: request.actor!.id, idempotencyKey: key!, requestId: request.requestId, now: now() });
    return sendWriteReply(request, reply, result, 200);
  });

  app.post("/v1/admin/catalog/sync-trigger", { preHandler: requireRole("admin") }, async (request, reply) => {
    const key = idempotencyKeyHeader(request);
    const keyCheck = requireIdempotencyKey(request.requestId, key);
    if (!keyCheck.valid) return reply.code(400).send(keyCheck.response);
    const result = admin.triggerCatalogSync({ actorId: request.actor!.id, idempotencyKey: key!, requestId: request.requestId, now: now() });
    return reply.code(201).send(success(request.requestId, result));
  });

  app.post("/v1/admin/prices/sync-trigger", { preHandler: requireRole("admin") }, async (request, reply) => {
    const key = idempotencyKeyHeader(request);
    const keyCheck = requireIdempotencyKey(request.requestId, key);
    if (!keyCheck.valid) return reply.code(400).send(keyCheck.response);
    const result = admin.triggerPriceSync({ actorId: request.actor!.id, idempotencyKey: key!, requestId: request.requestId, now: now() });
    return reply.code(201).send(success(request.requestId, result));
  });

  // ----- 活动定时发布 -----
  app.post("/v1/admin/campaigns/:id/schedule", { preHandler: requireRole("admin") }, async (request, reply) => {
    const key = idempotencyKeyHeader(request);
    const keyCheck = requireIdempotencyKey(request.requestId, key);
    if (!keyCheck.valid) return reply.code(400).send(keyCheck.response);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = publishBodySchema.parse(request.body);
    const result = admin.scheduleCampaign({ campaignId: id, previewVersion: body.previewVersion, actorId: request.actor!.id, idempotencyKey: key!, requestId: request.requestId, now: now() });
    return sendWriteReply(request, reply, result, 200);
  });

  // ----- MTGJSON 导入草稿 -----
  app.post("/v1/admin/mtgjson/setlist-draft", { preHandler: requireRole("admin") }, async (request, reply) => {
    const key = idempotencyKeyHeader(request);
    const keyCheck = requireIdempotencyKey(request.requestId, key);
    if (!keyCheck.valid) return reply.code(400).send(keyCheck.response);
    const body = setlistDraftBodySchema.parse(request.body);
    const result = admin.createSetlistDraft({ sourceVersion: body.sourceVersion, sourceChecksumSha256: body.sourceChecksumSha256 ?? null, setlist: body.setlist, actorId: request.actor!.id, idempotencyKey: key!, requestId: request.requestId, now: now() });
    return sendWriteReply(request, reply, result, 201);
  });

  app.get("/v1/admin/mtgjson/drafts", { preHandler: requireRole("admin") }, async (request) => {
    const { limit, offset } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), offset: z.coerce.number().int().min(0).default(0) }).strict().parse(request.query);
    return success(request.requestId, admin.listImportDrafts(limit, offset));
  });

  app.get("/v1/admin/mtgjson/drafts/:id", { preHandler: requireRole("admin") }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const draft = admin.getImportDraft(id);
    if (!draft) return reply.code(404).send(failure(request.requestId, "RESOURCE_NOT_FOUND", "草稿不存在"));
    return success(request.requestId, { draft });
  });

  app.post("/v1/admin/mtgjson/drafts/:id/preview", { preHandler: requireRole("admin") }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = admin.previewImportDraft(id, now());
    if (isErrorResult(result)) return sendErrorResult(request, reply, result);
    return success(request.requestId, result);
  });

  app.post("/v1/admin/mtgjson/drafts/:id/discard", { preHandler: requireRole("admin") }, async (request, reply) => {
    const key = idempotencyKeyHeader(request);
    const keyCheck = requireIdempotencyKey(request.requestId, key);
    if (!keyCheck.valid) return reply.code(400).send(keyCheck.response);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = admin.discardDraft({ draftId: id, actorId: request.actor!.id, idempotencyKey: key!, requestId: request.requestId, now: now() });
    return sendWriteReply(request, reply, result, 200);
  });

  // ----- 补充包规则 -----
  app.post("/v1/admin/packs/:packId/rule-preview", { preHandler: requireRole("admin") }, async (request, reply) => {
    const { packId } = z.object({ packId: z.string().uuid() }).parse(request.params);
    const definition = packRuleBodySchema.parse(request.body);
    const result = admin.previewPackRule(packId, definition);
    if (result === "not-found") return reply.code(404).send(failure(request.requestId, "RESOURCE_NOT_FOUND", "补充包不存在"));
    return success(request.requestId, result);
  });

  app.post("/v1/admin/packs/:packId/rule-publish", { preHandler: requireRole("admin") }, async (request, reply) => {
    const key = idempotencyKeyHeader(request);
    const keyCheck = requireIdempotencyKey(request.requestId, key);
    if (!keyCheck.valid) return reply.code(400).send(keyCheck.response);
    const { packId } = z.object({ packId: z.string().uuid() }).parse(request.params);
    const definition = packRuleBodySchema.parse(request.body);
    const result = admin.publishPackRule({ packId, definition, actorId: request.actor!.id, idempotencyKey: key!, requestId: request.requestId, now: now() });
    return sendWriteReply(request, reply, result, 201);
  });

  app.post("/v1/admin/packs/:packId/disable", { preHandler: requireRole("admin") }, async (request, reply) => {
    const key = idempotencyKeyHeader(request);
    const keyCheck = requireIdempotencyKey(request.requestId, key);
    if (!keyCheck.valid) return reply.code(400).send(keyCheck.response);
    const { packId } = z.object({ packId: z.string().uuid() }).parse(request.params);
    const body = disablePackBodySchema.parse(request.body);
    const result = admin.disablePack({ packId, reason: body.reason, actorId: request.actor!.id, idempotencyKey: key!, requestId: request.requestId, now: now() });
    return sendWriteReply(request, reply, result, 200);
  });
}

// ----- 路由层结果映射助手 -----

type FastifyLike = { requestId: string };

function sendErrorResult(request: FastifyLike & { requestId: string }, reply: { code: (code: number) => { send: (body: unknown) => void } }, result: AdminErrorResult): void {
  if (result.state === "not-found") reply.code(404).send(failure(request.requestId, "RESOURCE_NOT_FOUND", "资源不存在"));
  else if (result.state === "version-stale") reply.code(409).send(failure(request.requestId, "VERSION_STALE", "实体版本已变更，请重新预览"));
  else if (result.state === "validation") reply.code(400).send(failure(request.requestId, "VALIDATION_FAILED", result.message));
  else reply.code(409).send(failure(request.requestId, "RESOURCE_CONFLICT", result.message));
}

function isErrorResult(result: unknown): result is AdminErrorResult {
  if (typeof result !== "object" || result === null || !("state" in result)) return false;
  const state = (result as { state: unknown }).state;
  return state === "not-found" || state === "version-stale" || state === "validation" || state === "entity-conflict";
}

function sendWriteReply<T>(request: FastifyLike & { requestId: string }, reply: { code: (code: number) => { send: (body: unknown) => void } }, result: AdminWriteResult<T> | AdminErrorResult, successCode: number): void {
  // 使用存储的状态码，使业务冲突（如 409 VERSION_STALE）在重放时保持一致。
  if ("state" in result && (result.state === "completed" || result.state === "replayed")) {
    reply.code(result.statusCode).send(result.response);
    return;
  }
  if ("state" in result && result.state === "conflict") { reply.code(409).send(failure(request.requestId, "IDEMPOTENCY_CONFLICT", "Idempotency-Key 已用于不同请求")); return; }
  if ("state" in result && result.state === "in-progress") { reply.code(409).send(failure(request.requestId, "IDEMPOTENCY_IN_PROGRESS", "相同请求正在处理中")); return; }
  void successCode;
  sendErrorResult(request, reply, result as AdminErrorResult);
}

function sendPreviewResult<T>(request: FastifyLike & { requestId: string }, reply: { code: (code: number) => { send: (body: unknown) => void } }, result: T | AdminErrorResult): void {
  if (isErrorResult(result)) { sendErrorResult(request, reply, result); return; }
  reply.code(200).send(success(request.requestId, result));
}
