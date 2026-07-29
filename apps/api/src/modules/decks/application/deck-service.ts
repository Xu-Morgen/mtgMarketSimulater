import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { withinTransaction } from "@mtg-market/database";
import { canonicalizeRequest, type ApiResponse, type DeckCardEntryDto, type DeckDto, type DeckLegalityDto, type DeckPowerSnapshotDto } from "@mtg-market/contracts";
import { COMMANDER_BANLIST_VERSION, COMMANDER_DECK_RULE_VERSION, type DeckRuleCard, validateCommanderDeck } from "@mtg-market/rules";
import { failure, success } from "../../../shared/http/api-response.js";
import { encryptJsonPayload } from "../../../shared/security/encrypted-payload.js";
import type { LeylineEvaluation } from "../domain/leyline-evaluation.js";
const LEYLINE_ADAPTER_VERSION = "leyline-adapter/v1" as const;

export type SkuDeckCardInput = { zone: "commander" | "main" | "companion"; skuId: string; quantity: number };
export type VirtualDeckCardInput = { zone: "virtual_basic"; virtualBasic: "plains" | "island" | "swamp" | "mountain" | "forest"; quantity: number };
export type DraftCardInput = SkuDeckCardInput | VirtualDeckCardInput;
type PrintingRow = { sku_id: string; identity: string; name: string; color_identity_json: string; type_line: string; oracle_text: string | null; mana_value: number; legalities_json: string; available_quantity: number | null };
type DeckRow = { id: string; user_id: string; name: string; format: "commander-100/v1"; rule_version: string; banlist_version: string; legality_json: string; created_at: string; updated_at: string };
type CardRow = { zone: DeckCardEntryDto["zone"]; sku_id: string | null; virtual_basic: DeckCardEntryDto["virtualBasic"]; card_identity: string; card_name: string; quantity: number };
type IdempotencyRow = { request_fingerprint: string; status: string; response_status: number | null; response_json: string | null };
export type DeckCommandResult = { statusCode: number; response: ApiResponse<DeckDto> };

function fingerprint(body: unknown): string { return createHash("sha256").update(canonicalizeRequest(body)).digest("hex"); }
function jsonStrings(value: string, label: string): string[] { try { const parsed = JSON.parse(value) as unknown; if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error(); return parsed; } catch { throw new Error(`${label} 元数据损坏`); } }
function noResponse(statusCode: number, requestId: string, code: Parameters<typeof failure>[1], message: string): DeckCommandResult { return { statusCode, response: failure(requestId, code, message) }; }

/** Deck application 是草稿和只读合法性真相的唯一入口；本期绝不写 tournament hold。 */
export class DeckService {
  constructor(private readonly database: Database.Database) {}

  list(userId: string): DeckDto[] { return (this.database.prepare("SELECT * FROM decks WHERE user_id = ? ORDER BY updated_at DESC, id DESC").all(userId) as DeckRow[]).map((row) => this.dto(row)); }
  get(userId: string, deckId: string): DeckDto | null { const row = this.database.prepare("SELECT * FROM decks WHERE id = ? AND user_id = ?").get(deckId, userId) as DeckRow | undefined; return row ? this.dto(row) : null; }
  validate(userId: string, cards: DraftCardInput[], banlistVersion: string | undefined = COMMANDER_BANLIST_VERSION): DeckLegalityDto { return this.legality(userId, cards, banlistVersion, new Date().toISOString()); }

  create(input: { userId: string; name: string; cards: DraftCardInput[]; banlistVersion?: string | undefined; idempotencyKey: string; requestId: string }): DeckCommandResult {
    return this.write({ ...input, kind: "create" });
  }
  update(input: { userId: string; deckId: string; name: string; cards: DraftCardInput[]; banlistVersion?: string | undefined; idempotencyKey: string; requestId: string }): DeckCommandResult {
    return this.write({ ...input, kind: "update" });
  }

  /** I25B 报名在收费/锁卡前调用：此处只追加快照和服务器专用密文，不触及经济资产。 */
  saveLeylineSnapshot(input: { userId: string; deckId: string; registrationId: string; evaluation: LeylineEvaluation; encryptionKey: string; now?: string }): DeckPowerSnapshotDto {
    const now = input.now ?? new Date().toISOString();
    return withinTransaction(this.database, () => {
      const deck = this.get(input.userId, input.deckId); if (!deck) throw new Error("卡组不存在"); if (!deck.legality.valid) throw new Error("非法卡组不可生成报名评分快照");
      const snapshotId = randomUUID(); const encrypted = encryptJsonPayload(input.evaluation.rawResponse, input.encryptionKey);
      this.database.prepare("INSERT INTO deck_power_snapshots (id, deck_id, registration_id, source, source_version, provider_algorithm_version, score, input_summary_sha256, computed_at, availability, degradation_reason, response_sha256, details_json, created_at) VALUES (?, ?, ?, 'leyline', ?, 'undeclared', ?, ?, ?, 'available', NULL, ?, ?, ?)").run(snapshotId, input.deckId, input.registrationId, LEYLINE_ADAPTER_VERSION, input.evaluation.score, input.evaluation.inputSummarySha256, now, input.evaluation.responseSha256, JSON.stringify(input.evaluation.details), now);
      this.database.prepare("INSERT INTO deck_leyline_source_records (id, power_snapshot_id, adapter_version, request_decklist_sha256, response_sha256, encrypted_response, encryption_nonce, encryption_tag, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), snapshotId, LEYLINE_ADAPTER_VERSION, input.evaluation.inputSummarySha256, input.evaluation.responseSha256, encrypted.ciphertext, encrypted.nonce, encrypted.tag, now);
      return { source: "leyline", sourceVersion: LEYLINE_ADAPTER_VERSION, providerAlgorithmVersion: "undeclared", score: input.evaluation.score, inputSummarySha256: input.evaluation.inputSummarySha256, computedAt: now, availability: "available", degradationReason: null, responseSha256: input.evaluation.responseSha256 };
    });
  }

  private write(input: ({ userId: string; name: string; cards: DraftCardInput[]; banlistVersion?: string | undefined; idempotencyKey: string; requestId: string; kind: "create" } | { userId: string; deckId: string; name: string; cards: DraftCardInput[]; banlistVersion?: string | undefined; idempotencyKey: string; requestId: string; kind: "update" })): DeckCommandResult {
    const now = new Date().toISOString(); const requestFingerprint = fingerprint({ kind: input.kind, deckId: input.kind === "update" ? input.deckId : null, name: input.name, cards: input.cards, banlistVersion: input.banlistVersion ?? COMMANDER_BANLIST_VERSION });
    return withinTransaction(this.database, () => {
      const existing = this.database.prepare("SELECT request_fingerprint, status, response_status, response_json FROM idempotency_requests WHERE actor_id = ? AND idempotency_key = ?").get(input.userId, input.idempotencyKey) as IdempotencyRow | undefined;
      if (existing) return this.replay(existing, requestFingerprint, input.requestId);
      try { this.database.prepare("INSERT INTO idempotency_requests (id, actor_id, idempotency_key, request_fingerprint, status, response_status, response_json, created_at, completed_at) VALUES (?, ?, ?, ?, 'running', NULL, NULL, ?, NULL)").run(randomUUID(), input.userId, input.idempotencyKey, requestFingerprint, now); }
      catch { const raced = this.database.prepare("SELECT request_fingerprint, status, response_status, response_json FROM idempotency_requests WHERE actor_id = ? AND idempotency_key = ?").get(input.userId, input.idempotencyKey) as IdempotencyRow | undefined; return raced ? this.replay(raced, requestFingerprint, input.requestId) : noResponse(409, input.requestId, "IDEMPOTENCY_IN_PROGRESS", "请求正在处理"); }
      if (input.kind === "update" && !this.get(input.userId, input.deckId)) return this.complete(input.userId, input.idempotencyKey, now, noResponse(404, input.requestId, "RESOURCE_NOT_FOUND", "卡组不存在"));
      const banlistVersion = input.banlistVersion ?? COMMANDER_BANLIST_VERSION;
      let legality: DeckLegalityDto;
      try { legality = this.legality(input.userId, input.cards, banlistVersion, now); } catch (error) { return this.complete(input.userId, input.idempotencyKey, now, noResponse(400, input.requestId, "VALIDATION_FAILED", error instanceof Error ? error.message : "卡组参数无效")); }
      const deckId = input.kind === "update" ? input.deckId : randomUUID();
      if (input.kind === "create") this.database.prepare("INSERT INTO decks (id, user_id, name, format, rule_version, banlist_version, legality_json, created_at, updated_at) VALUES (?, ?, ?, 'commander-100/v1', ?, ?, ?, ?, ?)").run(deckId, input.userId, input.name, COMMANDER_DECK_RULE_VERSION, banlistVersion, JSON.stringify(legality), now, now);
      else { this.database.prepare("UPDATE decks SET name = ?, rule_version = ?, banlist_version = ?, legality_json = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(input.name, COMMANDER_DECK_RULE_VERSION, banlistVersion, JSON.stringify(legality), now, deckId, input.userId); this.database.prepare("DELETE FROM deck_cards WHERE deck_id = ?").run(deckId); }
      this.insertCards(deckId, input.cards);
      this.database.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, request_id, summary_json, occurred_at) VALUES (?, ?, ?, 'deck', ?, ?, ?, ?)").run(randomUUID(), input.userId, input.kind === "create" ? "deck.created" : "deck.updated", deckId, input.requestId, JSON.stringify({ valid: legality.valid, ruleVersion: legality.ruleVersion, banlistVersion }), now);
      const deck = this.get(input.userId, deckId)!;
      return this.complete(input.userId, input.idempotencyKey, now, { statusCode: input.kind === "create" ? 201 : 200, response: success(input.requestId, deck) });
    });
  }

  private complete(userId: string, key: string, now: string, result: DeckCommandResult): DeckCommandResult { this.database.prepare("UPDATE idempotency_requests SET status = 'completed', response_status = ?, response_json = ?, completed_at = ? WHERE actor_id = ? AND idempotency_key = ? AND status = 'running'").run(result.statusCode, JSON.stringify(result.response), now, userId, key); return result; }
  private replay(row: IdempotencyRow, expected: string, requestId: string): DeckCommandResult { if (row.request_fingerprint !== expected) return noResponse(409, requestId, "IDEMPOTENCY_CONFLICT", "同一幂等键对应不同请求"); if (row.status !== "completed" || !row.response_json || !row.response_status) return noResponse(409, requestId, "IDEMPOTENCY_IN_PROGRESS", "请求正在处理"); const response = JSON.parse(row.response_json) as ApiResponse<DeckDto>; response.meta.requestId = requestId; return { statusCode: row.response_status, response }; }

  private legality(userId: string, entries: DraftCardInput[], banlistVersion: string, checkedAt: string): DeckLegalityDto {
    const banlist = this.database.prepare("SELECT banned_names_json, banned_as_companion_names_json FROM commander_banlist_versions WHERE version = ?").get(banlistVersion) as { banned_names_json: string; banned_as_companion_names_json: string } | undefined;
    if (!banlist) throw new Error("禁牌表版本不存在");
    const banned = new Set(jsonStrings(banlist.banned_names_json, "禁牌表").map((name) => name.toLowerCase())); const bannedCompanion = new Set(jsonStrings(banlist.banned_as_companion_names_json, "Companion 禁牌表").map((name) => name.toLowerCase()));
    const skuIds = entries.filter((entry): entry is SkuDeckCardInput => "skuId" in entry).map((entry) => entry.skuId);
    if (new Set(skuIds).size !== skuIds.length) throw new Error("同一 SKU 只能在一个卡组区域出现一次");
    const cards = this.cardRows(userId, skuIds); if (cards.size !== skuIds.length) throw new Error("包含不存在的本地 SKU");
    const toRule = (row: PrintingRow): DeckRuleCard => ({ identity: row.identity, name: row.name, colorIdentity: jsonStrings(row.color_identity_json, "颜色标识").filter((color): color is "W" | "U" | "B" | "R" | "G" => ["W", "U", "B", "R", "G"].includes(color)), typeLine: row.type_line, oracleText: row.oracle_text ?? "", manaValue: row.mana_value, isCommanderLegal: JSON.parse(row.legalities_json).commander === "legal", isBanned: banned.has(row.name.toLowerCase()) || /\b(conspiracy|attraction|sticker)\b/i.test(row.type_line) || /\bante\b/i.test(row.oracle_text ?? ""), isBannedAsCompanion: bannedCompanion.has(row.name.toLowerCase()) });
    const commanders = entries.filter((entry): entry is SkuDeckCardInput => entry.zone === "commander").map((entry) => { if (entry.quantity !== 1) throw new Error("每张指挥官数量必须为 1"); return toRule(cards.get(entry.skuId)!); });
    const mains = entries.filter((entry): entry is SkuDeckCardInput => entry.zone === "main").map((entry) => ({ card: toRule(cards.get(entry.skuId)!), quantity: entry.quantity, zone: "main" as const }));
    const companionEntries = entries.filter((entry): entry is SkuDeckCardInput => entry.zone === "companion"); if (companionEntries.length > 1 || companionEntries.some((entry) => entry.quantity !== 1)) throw new Error("Companion 至多一张且数量必须为 1");
    const basics = Object.fromEntries(entries.filter((entry): entry is VirtualDeckCardInput => entry.zone === "virtual_basic").map((entry) => [entry.virtualBasic, entry.quantity]));
    const result = validateCommanderDeck({ version: COMMANDER_DECK_RULE_VERSION, banlistVersion, commanders, main: mains, virtualBasics: basics, companion: companionEntries[0] ? toRule(cards.get(companionEntries[0].skuId)!) : null });
    for (const entry of entries.filter((entry): entry is SkuDeckCardInput => "skuId" in entry)) { const row = cards.get(entry.skuId)!; if ((row.available_quantity ?? 0) < entry.quantity) result.issues.push(`可用库存不足：${row.name}`); }
    return { valid: result.issues.length === 0, totalCards: result.totalCards, colorIdentity: result.colors, issues: result.issues, ruleVersion: COMMANDER_DECK_RULE_VERSION, banlistVersion, checkedAt };
  }
  private cardRows(userId: string, skuIds: string[]): Map<string, PrintingRow> { if (skuIds.length === 0) return new Map(); const placeholders = skuIds.map(() => "?").join(","); const rows = this.database.prepare(`SELECT sku.id AS sku_id, COALESCE(p.oracle_id, p.scryfall_id, p.id) AS identity, p.name, p.color_identity_json, p.type_line, p.oracle_text, p.mana_value, p.legalities_json, h.available_quantity FROM card_skus sku JOIN card_printings p ON p.id = sku.printing_id LEFT JOIN inventory_holdings h ON h.sku_id = sku.id AND h.user_id = ? WHERE sku.id IN (${placeholders})`).all(userId, ...skuIds) as PrintingRow[]; return new Map(rows.map((row) => [row.sku_id, row])); }
  private insertCards(deckId: string, cards: DraftCardInput[]): void { const statement = this.database.prepare("INSERT INTO deck_cards (id, deck_id, zone, sku_id, virtual_basic, card_identity, card_name, quantity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"); const skuIds = cards.filter((entry): entry is SkuDeckCardInput => "skuId" in entry).map((entry) => entry.skuId); const metadata = this.cardRows("", skuIds); for (const card of cards) { if (card.zone === "virtual_basic") statement.run(randomUUID(), deckId, card.zone, null, card.virtualBasic, `virtual:${card.virtualBasic}`, ({ plains: "平原", island: "岛", swamp: "沼泽", mountain: "山脉", forest: "树林" } as const)[card.virtualBasic], card.quantity); else { const row = metadata.get(card.skuId); if (!row) { const fetched = this.database.prepare("SELECT sku.id AS sku_id, COALESCE(p.oracle_id, p.scryfall_id, p.id) AS identity, p.name, p.color_identity_json, p.type_line, p.oracle_text, p.mana_value, p.legalities_json, NULL AS available_quantity FROM card_skus sku JOIN card_printings p ON p.id = sku.printing_id WHERE sku.id = ?").get(card.skuId) as PrintingRow; statement.run(randomUUID(), deckId, card.zone, card.skuId, null, fetched.identity, fetched.name, card.quantity); } else statement.run(randomUUID(), deckId, card.zone, card.skuId, null, row.identity, row.name, card.quantity); } } }
  private dto(row: DeckRow): DeckDto { const cards = this.database.prepare("SELECT zone, sku_id, virtual_basic, card_identity, card_name, quantity FROM deck_cards WHERE deck_id = ? ORDER BY CASE zone WHEN 'commander' THEN 1 WHEN 'companion' THEN 2 WHEN 'main' THEN 3 ELSE 4 END, card_name").all(row.id) as CardRow[]; return { id: row.id, name: row.name, format: row.format, ruleVersion: row.rule_version, banlistVersion: row.banlist_version, cards: cards.map((card) => ({ zone: card.zone, skuId: card.sku_id, virtualBasic: card.virtual_basic, quantity: card.quantity, name: card.card_name, cardIdentity: card.card_identity })), legality: JSON.parse(row.legality_json) as DeckLegalityDto, strengthSnapshot: null, createdAt: row.created_at, updatedAt: row.updated_at }; }
}
