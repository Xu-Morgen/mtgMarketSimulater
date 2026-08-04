import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { canonicalizeRequest, type ApiResponse, type WatchlistAlertsDto, type WatchlistItemDto, type WatchlistLimitsDto } from "@mtg-market/contracts";
import { withinTransaction } from "@mtg-market/database";
import { failure, success } from "../../../shared/http/api-response.js";
import { hitWatchlistTarget, type WatchlistDirection, type WatchlistTargetType } from "../domain/watchlist.js";

type ItemRow = { id: string; sku_id: string; target_type: string; direction: string; target_amount: number; enabled: number; created_at: string; updated_at: string };
type AlertRow = { id: string; watchlist_item_id: string; sku_id: string; target_type: string; direction: string; target_amount: number; triggered_price: number; triggered_at: string; read_at: string | null };
type IdempotencyRow = { request_fingerprint: string; status: string; response_status: number | null; response_json: string | null };

export type WatchlistUpsertResult =
  | { state: "completed"; statusCode: number; response: ApiResponse<WatchlistItemDto> }
  | { state: "replayed"; statusCode: number; response: ApiResponse<WatchlistItemDto> }
  | { state: "conflict" }
  | { state: "in-progress" };
export type WatchlistRemoveResult =
  | { state: "completed"; statusCode: number; response: ApiResponse<{ removed: boolean }> }
  | { state: "replayed"; statusCode: number; response: ApiResponse<{ removed: boolean }> }
  | { state: "conflict" }
  | { state: "in-progress" };
export type WatchlistReadResult =
  | { state: "completed"; statusCode: number; response: ApiResponse<{ alertId: string; read: boolean }> }
  | { state: "replayed"; statusCode: number; response: ApiResponse<{ alertId: string; read: boolean }> }
  | { state: "conflict" }
  | { state: "in-progress" };

/**
 * I34B（E12）：Watchlist 用例。条目/提醒只保存用户意图与目标价，命中判定由 `checkAlerts`
 * 任务以最新报价快照执行；提醒不结算、不扣费、不影响价格与市场。写操作复用幂等键与审计。
 */
export class WatchlistService {
  constructor(private readonly database: Database.Database) {}

  limits(): WatchlistLimitsDto {
    const row = this.database.prepare("SELECT max_items_per_user FROM watchlist_limits WHERE singleton = 1").get() as { max_items_per_user: number } | undefined;
    if (!row) throw new Error("Watchlist 额度未初始化");
    return { maxItemsPerUser: row.max_items_per_user };
  }

  list(userId: string): WatchlistItemDto[] {
    const rows = this.database.prepare(
      "SELECT id, sku_id, target_type, direction, target_amount, enabled, created_at, updated_at FROM watchlist_items WHERE user_id = ? ORDER BY created_at DESC, id DESC"
    ).all(userId) as ItemRow[];
    return rows.map((row) => this.toItemDto(row));
  }

  upsert(input: {
    userId: string;
    skuId: string;
    targetType: WatchlistTargetType;
    direction: WatchlistDirection;
    targetAmount: number;
    enabled: boolean;
    idempotencyKey: string;
    requestFingerprint: string;
    requestId: string;
    now?: Date;
  }): WatchlistUpsertResult {
    const now = (input.now ?? new Date()).toISOString();
    return withinTransaction(this.database, () => {
      const existing = this.findIdempotency(input.userId, input.idempotencyKey);
      if (existing) return this.upsertIdempotencyResult(existing, input.requestFingerprint);
      try {
        this.database.prepare(
          "INSERT INTO idempotency_requests (id, actor_id, idempotency_key, request_fingerprint, status, response_status, response_json, created_at, completed_at) VALUES (?, ?, ?, ?, 'running', NULL, NULL, ?, NULL)"
        ).run(randomUUID(), input.userId, input.idempotencyKey, input.requestFingerprint, now);
      } catch {
        const raced = this.findIdempotency(input.userId, input.idempotencyKey);
        return raced ? this.upsertIdempotencyResult(raced, input.requestFingerprint) : { state: "in-progress" };
      }
      if (!this.database.prepare("SELECT 1 FROM card_skus WHERE id = ?").get(input.skuId))
        return this.completeUpsertFailure(input, now, 404, "RESOURCE_NOT_FOUND", "该 SKU 不存在");

      const count = (this.database.prepare("SELECT COUNT(*) AS count FROM watchlist_items WHERE user_id = ?").get(input.userId) as { count: number }).count;
      const existingRow = this.database.prepare("SELECT 1 FROM watchlist_items WHERE user_id = ? AND sku_id = ?").get(input.userId, input.skuId);
      if (!existingRow && count >= this.limits().maxItemsPerUser)
        return this.completeUpsertFailure(input, now, 409, "RULE_VIOLATION", `Watchlist 条目数已达上限（${this.limits().maxItemsPerUser}）`);

      const id = existingRow
        ? (this.database.prepare("SELECT id FROM watchlist_items WHERE user_id = ? AND sku_id = ?").get(input.userId, input.skuId) as ItemRow).id
        : randomUUID();
      this.database.prepare(
        `INSERT INTO watchlist_items (id, user_id, sku_id, target_type, direction, target_amount, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, sku_id) DO UPDATE SET
           target_type = excluded.target_type, direction = excluded.direction, target_amount = excluded.target_amount,
           enabled = excluded.enabled, updated_at = excluded.updated_at`
      ).run(id, input.userId, input.skuId, input.targetType, input.direction, input.targetAmount, input.enabled ? 1 : 0, now, now);
      const row = this.database.prepare("SELECT id, sku_id, target_type, direction, target_amount, enabled, created_at, updated_at FROM watchlist_items WHERE id = ?").get(id) as ItemRow;
      this.database.prepare(
        "INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, request_id, summary_json, occurred_at) VALUES (?, ?, 'watchlist.upserted', 'watchlist_item', ?, ?, ?, ?)"
      ).run(randomUUID(), input.userId, id, input.requestId, JSON.stringify({ skuId: input.skuId, targetType: input.targetType, direction: input.direction, targetAmount: input.targetAmount, enabled: input.enabled }), now);
      const response = success(input.requestId, this.toItemDto(row));
      this.completeUpsertIdempotency(input.userId, input.idempotencyKey, 200, response, now);
      return { state: "completed", statusCode: 200, response };
    });
  }

  remove(input: { userId: string; skuId: string; idempotencyKey: string; requestFingerprint: string; requestId: string; now?: Date }): WatchlistRemoveResult {
    const now = (input.now ?? new Date()).toISOString();
    return withinTransaction(this.database, () => {
      const existing = this.findIdempotency(input.userId, input.idempotencyKey);
      if (existing) return this.removeIdempotencyResult(existing, input.requestFingerprint);
      try {
        this.database.prepare(
          "INSERT INTO idempotency_requests (id, actor_id, idempotency_key, request_fingerprint, status, response_status, response_json, created_at, completed_at) VALUES (?, ?, ?, ?, 'running', NULL, NULL, ?, NULL)"
        ).run(randomUUID(), input.userId, input.idempotencyKey, input.requestFingerprint, now);
      } catch {
        const raced = this.findIdempotency(input.userId, input.idempotencyKey);
        return raced ? this.removeIdempotencyResult(raced, input.requestFingerprint) : { state: "in-progress" };
      }
      const removed = this.database.prepare("DELETE FROM watchlist_items WHERE user_id = ? AND sku_id = ?").run(input.userId, input.skuId).changes === 1;
      if (removed) {
        this.database.prepare(
          "INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, request_id, summary_json, occurred_at) VALUES (?, ?, 'watchlist.removed', 'watchlist_item', ?, ?, ?, ?)"
        ).run(randomUUID(), input.userId, `sku:${input.skuId}`, input.requestId, JSON.stringify({ skuId: input.skuId }), now);
      }
      const response = success(input.requestId, { removed });
      this.completeRemoveIdempotency(input.userId, input.idempotencyKey, 200, response, now);
      return { state: "completed", statusCode: 200, response };
    });
  }

  alerts(userId: string): WatchlistAlertsDto {
    const rows = this.database.prepare(
      "SELECT id, watchlist_item_id, sku_id, target_type, direction, target_amount, triggered_price, triggered_at, read_at FROM watchlist_alerts WHERE user_id = ? ORDER BY triggered_at DESC, id DESC LIMIT 100"
    ).all(userId) as AlertRow[];
    const unread = this.database.prepare("SELECT COUNT(*) AS count FROM watchlist_alerts WHERE user_id = ? AND read_at IS NULL").get(userId) as { count: number };
    return {
      items: rows.map((row) => ({
        id: row.id,
        watchlistItemId: row.watchlist_item_id,
        skuId: row.sku_id,
        targetType: row.target_type as WatchlistTargetType,
        direction: row.direction as WatchlistDirection,
        targetAmount: row.target_amount,
        triggeredPrice: row.triggered_price,
        triggeredAt: row.triggered_at,
        read: row.read_at !== null
      })),
      unreadCount: unread.count
    };
  }

  markAlertRead(input: { userId: string; alertId: string; idempotencyKey: string; requestFingerprint: string; requestId: string; now?: Date }): WatchlistReadResult {
    const now = (input.now ?? new Date()).toISOString();
    return withinTransaction(this.database, () => {
      const existing = this.findIdempotency(input.userId, input.idempotencyKey);
      if (existing) return this.readIdempotencyResult(existing, input.requestFingerprint);
      try {
        this.database.prepare(
          "INSERT INTO idempotency_requests (id, actor_id, idempotency_key, request_fingerprint, status, response_status, response_json, created_at, completed_at) VALUES (?, ?, ?, ?, 'running', NULL, NULL, ?, NULL)"
        ).run(randomUUID(), input.userId, input.idempotencyKey, input.requestFingerprint, now);
      } catch {
        const raced = this.findIdempotency(input.userId, input.idempotencyKey);
        return raced ? this.readIdempotencyResult(raced, input.requestFingerprint) : { state: "in-progress" };
      }
      const updated = this.database.prepare(
        "UPDATE watchlist_alerts SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL"
      ).run(now, input.alertId, input.userId);
      if (updated.changes === 0) {
        // 不存在或已读：已读按幂等成功处理（再次标记已读无副作用）。
        const belongs = this.database.prepare("SELECT 1 FROM watchlist_alerts WHERE id = ? AND user_id = ?").get(input.alertId, input.userId);
        if (!belongs) return this.completeReadFailure(input, now, 404, "RESOURCE_NOT_FOUND", "该提醒不存在");
      }
      const response = success(input.requestId, { alertId: input.alertId, read: true });
      this.completeReadIdempotency(input.userId, input.idempotencyKey, 200, response, now);
      return { state: "completed", statusCode: 200, response };
    });
  }

  /**
   * 任务处理器唯一入口：对全部启用条目按最新报价快照执行命中判定，命中写 `watchlist_alerts`。
   * 以 (user_id, watchlist_item_id, triggered_quote_id) 唯一约束收敛并发与补跑——同一报价只产生
   * 一次提醒（至多一次通知）；只读价格与市场，不写任何经济表；任务失败不影响报价与市场。
   */
  checkAlerts(now = new Date().toISOString()): { triggered: number } {
    return withinTransaction(this.database, () => {
      const rows = this.database.prepare(
        `SELECT item.id, item.user_id, item.sku_id, item.target_type, item.direction, item.target_amount
         FROM watchlist_items item WHERE item.enabled = 1 ORDER BY item.user_id, item.sku_id`
      ).all() as Array<{ id: string; user_id: string; sku_id: string; target_type: string; direction: string; target_amount: number }>;
      let triggered = 0;
      for (const row of rows) {
        const quote = this.database.prepare(
          `SELECT quote.id, quote.market_price_amount, quote.reference_price_eur_cents
           FROM market_quotes quote WHERE quote.sku_id = ?
           ORDER BY quote.calculated_at DESC, quote.rowid DESC LIMIT 1`
        ).get(row.sku_id) as { id: string; market_price_amount: number; reference_price_eur_cents: number } | undefined;
        if (!quote) continue;
        const currentPrice = row.target_type === "game_price" ? quote.market_price_amount : quote.reference_price_eur_cents;
        if (!hitWatchlistTarget(row.direction as WatchlistDirection, currentPrice, row.target_amount)) continue;
        const alertId = randomUUID();
        this.database.prepare(
          `INSERT INTO watchlist_alerts (id, user_id, watchlist_item_id, sku_id, target_type, direction, target_amount, triggered_quote_id, triggered_price, triggered_at, read_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT(user_id, watchlist_item_id, triggered_quote_id) DO NOTHING`
        ).run(alertId, row.user_id, row.id, row.sku_id, row.target_type, row.direction, row.target_amount, quote.id, currentPrice, now);
        const inserted = this.database.prepare("SELECT 1 FROM watchlist_alerts WHERE id = ?").get(alertId);
        if (inserted) triggered += 1;
      }
      return { triggered };
    });
  }

  private toItemDto(row: ItemRow): WatchlistItemDto {
    return {
      id: row.id,
      skuId: row.sku_id,
      targetType: row.target_type as WatchlistTargetType,
      direction: row.direction as WatchlistDirection,
      targetAmount: row.target_amount,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private findIdempotency(actorId: string, key: string): IdempotencyRow | undefined {
    return this.database.prepare(
      "SELECT request_fingerprint, status, response_status, response_json FROM idempotency_requests WHERE actor_id = ? AND idempotency_key = ?"
    ).get(actorId, key) as IdempotencyRow | undefined;
  }

  private upsertIdempotencyResult(existing: IdempotencyRow, fingerprint: string): WatchlistUpsertResult {
    if (existing.request_fingerprint !== fingerprint) return { state: "conflict" };
    if (existing.status !== "completed" || !existing.response_status || !existing.response_json) return { state: "in-progress" };
    return { state: "replayed", statusCode: existing.response_status, response: JSON.parse(existing.response_json) as ApiResponse<WatchlistItemDto> };
  }

  private completeUpsertFailure(input: { userId: string; idempotencyKey: string; requestId: string }, now: string, statusCode: number, code: "RESOURCE_NOT_FOUND" | "RULE_VIOLATION", message: string): WatchlistUpsertResult {
    const response = failure(input.requestId, code, message);
    this.completeUpsertIdempotency(input.userId, input.idempotencyKey, statusCode, response, now);
    return { state: "completed", statusCode, response };
  }

  private completeUpsertIdempotency(actorId: string, key: string, statusCode: number, response: ApiResponse<WatchlistItemDto>, now: string): void {
    const updated = this.database.prepare(
      "UPDATE idempotency_requests SET status = 'completed', response_status = ?, response_json = ?, completed_at = ? WHERE actor_id = ? AND idempotency_key = ? AND status = 'running'"
    ).run(statusCode, JSON.stringify(response), now, actorId, key);
    if (updated.changes !== 1) throw new Error("Watchlist 写入幂等请求状态损坏");
  }

  private removeIdempotencyResult(existing: IdempotencyRow, fingerprint: string): WatchlistRemoveResult {
    if (existing.request_fingerprint !== fingerprint) return { state: "conflict" };
    if (existing.status !== "completed" || !existing.response_status || !existing.response_json) return { state: "in-progress" };
    return { state: "replayed", statusCode: existing.response_status, response: JSON.parse(existing.response_json) as ApiResponse<{ removed: boolean }> };
  }

  private completeRemoveIdempotency(actorId: string, key: string, statusCode: number, response: ApiResponse<{ removed: boolean }>, now: string): void {
    const updated = this.database.prepare(
      "UPDATE idempotency_requests SET status = 'completed', response_status = ?, response_json = ?, completed_at = ? WHERE actor_id = ? AND idempotency_key = ? AND status = 'running'"
    ).run(statusCode, JSON.stringify(response), now, actorId, key);
    if (updated.changes !== 1) throw new Error("Watchlist 删除幂等请求状态损坏");
  }

  private readIdempotencyResult(existing: IdempotencyRow, fingerprint: string): WatchlistReadResult {
    if (existing.request_fingerprint !== fingerprint) return { state: "conflict" };
    if (existing.status !== "completed" || !existing.response_status || !existing.response_json) return { state: "in-progress" };
    return { state: "replayed", statusCode: existing.response_status, response: JSON.parse(existing.response_json) as ApiResponse<{ alertId: string; read: boolean }> };
  }

  private completeReadFailure(input: { userId: string; idempotencyKey: string; requestId: string }, now: string, statusCode: number, code: "RESOURCE_NOT_FOUND", message: string): WatchlistReadResult {
    const response = failure(input.requestId, code, message);
    this.completeReadIdempotency(input.userId, input.idempotencyKey, statusCode, response, now);
    return { state: "completed", statusCode, response };
  }

  private completeReadIdempotency(actorId: string, key: string, statusCode: number, response: ApiResponse<{ alertId: string; read: boolean }>, now: string): void {
    const updated = this.database.prepare(
      "UPDATE idempotency_requests SET status = 'completed', response_status = ?, response_json = ?, completed_at = ? WHERE actor_id = ? AND idempotency_key = ? AND status = 'running'"
    ).run(statusCode, JSON.stringify(response), now, actorId, key);
    if (updated.changes !== 1) throw new Error("Watchlist 提醒已读幂等请求状态损坏");
  }
}

/** 幂等指纹：upsert 依赖规范化后的意图体，删除/已读依赖路径参数。 */
export function watchlistUpsertRequestFingerprint(body: unknown): string {
  return createHash("sha256").update(canonicalizeRequest(body)).digest("hex");
}

export function watchlistPathRequestFingerprint(params: Record<string, string>): string {
  return createHash("sha256").update(canonicalizeRequest(params)).digest("hex");
}
