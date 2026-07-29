import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { failure, success } from "../../../shared/http/api-response.js";
import { requireRole } from "../../auth/api/auth-routes.js";
import { DeckService, type DraftCardInput } from "../application/deck-service.js";

const skuCardSchema = z.object({ zone: z.enum(["commander", "main", "companion"]), skuId: z.string().uuid(), quantity: z.number().int().min(1).max(100) }).strict();
const virtualCardSchema = z.object({ zone: z.literal("virtual_basic"), virtualBasic: z.enum(["plains", "island", "swamp", "mountain", "forest"]), quantity: z.number().int().min(1).max(100) }).strict();
const deckBodySchema = z.object({ name: z.string().trim().min(1).max(100), banlistVersion: z.string().trim().min(1).max(100).optional(), cards: z.array(z.union([skuCardSchema, virtualCardSchema])).min(1).max(110) }).strict();
const deckParams = z.object({ deckId: z.string().uuid() }).strict();
function key(value: unknown): string | null { return typeof value === "string" && value.length >= 8 && value.length <= 200 ? value : null; }

/** 草稿保存和合法性均由服务端决定；没有任何比赛锁定端点。 */
export async function registerDeckRoutes(app: FastifyInstance, database: Database.Database): Promise<void> {
  const decks = new DeckService(database);
  app.get("/v1/decks", { preHandler: requireRole("player") }, async (request) => success(request.requestId, { items: decks.list(request.actor!.id) }));
  app.get("/v1/decks/:deckId", { preHandler: requireRole("player") }, async (request, reply) => { const deck = decks.get(request.actor!.id, deckParams.parse(request.params).deckId); return deck ? success(request.requestId, deck) : reply.code(404).send(failure(request.requestId, "RESOURCE_NOT_FOUND", "卡组不存在")); });
  app.post("/v1/decks/validate", { preHandler: requireRole("player") }, async (request, reply) => { const body = deckBodySchema.parse(request.body); try { return success(request.requestId, decks.validate(request.actor!.id, body.cards as DraftCardInput[], body.banlistVersion)); } catch (error) { return reply.code(400).send(failure(request.requestId, "VALIDATION_FAILED", error instanceof Error ? error.message : "卡组参数无效")); } });
  app.post("/v1/decks", { preHandler: requireRole("player") }, async (request, reply) => { const idempotencyKey = key(request.headers["idempotency-key"]); if (!idempotencyKey) return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带 Idempotency-Key")); const body = deckBodySchema.parse(request.body); const result = decks.create({ userId: request.actor!.id, name: body.name, cards: body.cards as DraftCardInput[], banlistVersion: body.banlistVersion, idempotencyKey, requestId: request.requestId }); return reply.code(result.statusCode).send(result.response); });
  app.put("/v1/decks/:deckId", { preHandler: requireRole("player") }, async (request, reply) => { const idempotencyKey = key(request.headers["idempotency-key"]); if (!idempotencyKey) return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带 Idempotency-Key")); const body = deckBodySchema.parse(request.body); const result = decks.update({ userId: request.actor!.id, deckId: deckParams.parse(request.params).deckId, name: body.name, cards: body.cards as DraftCardInput[], banlistVersion: body.banlistVersion, idempotencyKey, requestId: request.requestId }); return reply.code(result.statusCode).send(result.response); });
}
