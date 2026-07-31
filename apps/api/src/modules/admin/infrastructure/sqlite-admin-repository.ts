import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  AdminAuditLogDto,
  AdminCampaignDto,
  AdminExceptionTradeDto,
  AdminUserDetailDto,
  AdminUserListItemDto,
  CampaignScopeType,
  CampaignStatus,
  CampaignType,
  MtgjsonDraftKind,
  MtgjsonDraftMappingStatus,
  MtgjsonDraftStatus,
  Page
} from "@mtg-market/contracts";

/**
 * I30B 管理后台仓储。仅负责 SQL 读写与行映射，不承载业务决策。
 * 经济补偿、活动发布等写入由 AdminService 在 SQLite 短事务内调用本仓储与各模块 application 端口完成；
 * 本仓储不跨模块直写 users/accounts/inventory 等他模块表（用户冻结、会话撤销除外，因其仅改 users/sessions 行）。
 */

export interface AuditLogFilters {
  from?: string | undefined;
  to?: string | undefined;
  actorId?: string | undefined;
  userId?: string | undefined;
  entityType?: string | undefined;
  entityId?: string | undefined;
  action?: string | undefined;
  requestId?: string | undefined;
  taskType?: string | undefined;
}

export interface CampaignRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  campaign_type: CampaignType;
  scope_type: CampaignScopeType;
  scope_id: string | null;
  factor_bps: number;
  display_text: string;
  starts_at: string;
  ends_at: string;
  status: CampaignStatus;
  version: number;
  published_market_event_id: string | null;
  reason: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  paused_at: string | null;
  ended_at: string | null;
}

export interface ImportDraftRow {
  id: string;
  draft_kind: MtgjsonDraftKind;
  source_version: string;
  source_checksum_sha256: string | null;
  set_code: string | null;
  payload_json: string;
  mapping_status: MtgjsonDraftMappingStatus;
  mapping_summary_json: string | null;
  status: MtgjsonDraftStatus;
  version: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface IdempotencyRecord {
  request_fingerprint: string;
  status: string;
  response_status: number | null;
  response_json: string | null;
}

function toCampaignDto(row: CampaignRow): AdminCampaignDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    campaignType: row.campaign_type,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    factorBps: row.factor_bps,
    displayText: row.display_text,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    version: row.version,
    publishedMarketEventId: row.published_market_event_id,
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    pausedAt: row.paused_at,
    endedAt: row.ended_at
  };
}

function toImportDraftDto(row: ImportDraftRow) {
  return {
    id: row.id,
    draftKind: row.draft_kind,
    sourceVersion: row.source_version,
    sourceChecksumSha256: row.source_checksum_sha256,
    setCode: row.set_code,
    mappingStatus: row.mapping_status,
    status: row.status,
    version: row.version,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** I30B 管理后台只读与草稿仓储；经济写入由各模块 application 端口协作完成。 */
export class SqliteAdminRepository {
  constructor(private readonly database: Database.Database) {}

  // ----- 幂等记录（与既有模块模式一致；UNIQUE(actor_id, idempotency_key) 去重） -----

  findIdempotency(actorId: string, idempotencyKey: string): IdempotencyRecord | null {
    const row = this.database
      .prepare("SELECT request_fingerprint, status, response_status, response_json FROM idempotency_requests WHERE actor_id = ? AND idempotency_key = ?")
      .get(actorId, idempotencyKey) as IdempotencyRecord | undefined;
    return row ?? null;
  }

  beginIdempotency(actorId: string, idempotencyKey: string, fingerprint: string, now: string): "inserted" | "conflict" {
    const result = this.database
      .prepare(
        "INSERT OR IGNORE INTO idempotency_requests (id, actor_id, idempotency_key, request_fingerprint, status, response_status, response_json, created_at, completed_at) VALUES (?, ?, ?, ?, 'running', NULL, NULL, ?, NULL)"
      )
      .run(randomUUID(), actorId, idempotencyKey, fingerprint, now);
    if (result.changes === 1) return "inserted";
    return "conflict";
  }

  completeIdempotency(actorId: string, idempotencyKey: string, responseStatus: number, responseJson: string, now: string): void {
    this.database
      .prepare(
        "UPDATE idempotency_requests SET status = 'completed', response_status = ?, response_json = ?, completed_at = ? WHERE actor_id = ? AND idempotency_key = ? AND status = 'running'"
      )
      .run(responseStatus, responseJson, now, actorId, idempotencyKey);
  }

  // ----- 审计日志（只读、服务端分页、脱敏由写入方保证） -----

  listAuditLogs(filters: AuditLogFilters, cursor: string | undefined, limit: number): Page<AdminAuditLogDto> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters.from) { where.push("occurred_at >= ?"); params.push(filters.from); }
    if (filters.to) { where.push("occurred_at <= ?"); params.push(filters.to); }
    if (filters.actorId) { where.push("actor_id = ?"); params.push(filters.actorId); }
    if (filters.userId) { where.push("(entity_type = 'user' AND entity_id = ?)"); params.push(filters.userId); }
    if (filters.entityType) { where.push("entity_type = ?"); params.push(filters.entityType); }
    if (filters.entityId) { where.push("entity_id = ?"); params.push(filters.entityId); }
    if (filters.action) { where.push("action LIKE ?"); params.push(`%${filters.action}%`); }
    if (filters.requestId) { where.push("request_id = ?"); params.push(filters.requestId); }
    if (filters.taskType) { where.push("summary_json LIKE ?"); params.push(`%"taskType":"${filters.taskType}"%`); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const offset = cursor ? Number.parseInt(cursor, 10) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("审计日志分页游标无效");
    const rows = this.database
      .prepare(`SELECT id, actor_id, action, entity_type, entity_id, request_id, summary_json, occurred_at FROM audit_logs ${clause} ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit + 1, offset) as Array<{ id: string; actor_id: string | null; action: string; entity_type: string; entity_id: string; request_id: string | null; summary_json: string; occurred_at: string }>;
    const hasMore = rows.length > limit;
    const visible = rows.slice(0, limit);
    return {
      items: visible.map((row) => ({
        id: row.id,
        actorId: row.actor_id,
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        requestId: row.request_id,
        occurredAt: row.occurred_at,
        summary: safeParseSummary(row.summary_json)
      })),
      page: { hasMore, nextCursor: hasMore ? String(offset + limit) : null }
    };
  }

  getAuditLog(id: string): AdminAuditLogDto | null {
    const row = this.database
      .prepare("SELECT id, actor_id, action, entity_type, entity_id, request_id, summary_json, occurred_at FROM audit_logs WHERE id = ?")
      .get(id) as { id: string; actor_id: string | null; action: string; entity_type: string; entity_id: string; request_id: string | null; summary_json: string; occurred_at: string } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      actorId: row.actor_id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      requestId: row.request_id,
      occurredAt: row.occurred_at,
      summary: safeParseSummary(row.summary_json)
    };
  }

  listRelatedLogs(entityType: string, entityId: string, limit: number): AdminAuditLogDto[] {
    const rows = this.database
      .prepare("SELECT id, actor_id, action, entity_type, entity_id, request_id, summary_json, occurred_at FROM audit_logs WHERE entity_type = ? AND entity_id = ? ORDER BY occurred_at DESC, id DESC LIMIT ?")
      .all(entityType, entityId, limit) as Array<{ id: string; actor_id: string | null; action: string; entity_type: string; entity_id: string; request_id: string | null; summary_json: string; occurred_at: string }>;
    return rows.map((row) => ({
      id: row.id,
      actorId: row.actor_id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      requestId: row.request_id,
      occurredAt: row.occurred_at,
      summary: safeParseSummary(row.summary_json)
    }));
  }

  listRecentActions(limit: number): AdminAuditLogDto[] {
    const rows = this.database
      .prepare("SELECT id, actor_id, action, entity_type, entity_id, request_id, summary_json, occurred_at FROM audit_logs ORDER BY occurred_at DESC, id DESC LIMIT ?")
      .all(limit) as Array<{ id: string; actor_id: string | null; action: string; entity_type: string; entity_id: string; request_id: string | null; summary_json: string; occurred_at: string }>;
    return rows.map((row) => ({
      id: row.id,
      actorId: row.actor_id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      requestId: row.request_id,
      occurredAt: row.occurred_at,
      summary: safeParseSummary(row.summary_json)
    }));
  }

  // ----- 异常交易/待复核（聚合 flagged 风控 + 失败任务） -----

  listExceptionTrades(limit: number): AdminExceptionTradeDto[] {
    const flagged = this.database
      .prepare("SELECT id, user_id, sku_id, action, outcome, reasons_json, rule_version, request_id, created_at FROM order_risk_decisions WHERE outcome = 'flagged' ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Array<{ id: string; user_id: string; sku_id: string; action: string; outcome: string; reasons_json: string; rule_version: string; request_id: string | null; created_at: string }>;
    const failedJobs = this.database
      .prepare("SELECT id, type, last_error, status, created_at FROM jobs WHERE status IN ('failed', 'dead') ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Array<{ id: string; type: string; last_error: string | null; status: string; created_at: string }>;
    const items: AdminExceptionTradeDto[] = flagged.map((row) => ({
      id: row.id,
      kind: "risk_flagged" as const,
      userId: row.user_id,
      entityType: "order_risk_decision",
      entityId: row.id,
      reason: safeParseSummary(row.reasons_json).toString(),
      status: row.outcome,
      occurredAt: row.created_at,
      requestId: row.request_id
    }));
    for (const job of failedJobs) {
      items.push({
        id: job.id,
        kind: "failed_job",
        userId: null,
        entityType: "job",
        entityId: job.id,
        reason: job.last_error ?? job.type,
        status: job.status,
        occurredAt: job.created_at,
        requestId: null
      });
    }
    return items.slice(0, limit);
  }

  countFailedJobs(): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('failed', 'dead')").get() as { count: number };
    return row.count;
  }

  // ----- 用户管理（仅改 users/sessions 行；账户与库存补偿经模块 application 端口） -----

  searchUsers(query: { userId?: string | undefined; username?: string | undefined; role?: string | undefined; status?: "active" | "frozen" | undefined }, limit: number, offset: number): { items: AdminUserListItemDto[]; total: number } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.userId) { where.push("id = ?"); params.push(query.userId); }
    if (query.username) { where.push("(email LIKE ? OR display_name LIKE ?)"); params.push(`%${query.username}%`, `%${query.username}%`); }
    if (query.role) { where.push("role = ?"); params.push(query.role); }
    if (query.status === "frozen") { where.push("frozen_at IS NOT NULL"); }
    if (query.status === "active") { where.push("frozen_at IS NULL"); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (this.database.prepare(`SELECT COUNT(*) AS count FROM users ${clause}`).get(...params) as { count: number }).count;
    const rows = this.database
      .prepare(`SELECT id, email, display_name, role, frozen_at, frozen_reason, created_at, updated_at FROM users ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Array<{ id: string; email: string; display_name: string; role: string; frozen_at: string | null; frozen_reason: string | null; created_at: string; updated_at: string }>;
    return {
      items: rows.map((row) => ({
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        role: row.role as "player" | "admin",
        frozen: row.frozen_at !== null,
        frozenReason: row.frozen_reason,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      })),
      total
    };
  }

  getUserDetail(userId: string): AdminUserDetailDto | null {
    const row = this.database
      .prepare("SELECT id, email, display_name, role, frozen_at, frozen_reason, created_at, updated_at FROM users WHERE id = ?")
      .get(userId) as { id: string; email: string; display_name: string; role: string; frozen_at: string | null; frozen_reason: string | null; created_at: string; updated_at: string } | undefined;
    if (!row) return null;
    const sessionRow = this.database.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?").get(userId, new Date().toISOString()) as { count: number };
    const accountRow = this.database.prepare("SELECT currency, total_amount, available_amount, frozen_amount FROM accounts WHERE user_id = ? AND currency = 'GAME_CREDIT'").get(userId) as { currency: string; total_amount: number; available_amount: number; frozen_amount: number } | undefined;
    const recentAudit = this.listRelatedLogs("user", userId, 5);
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      role: row.role as "player" | "admin",
      frozen: row.frozen_at !== null,
      frozenReason: row.frozen_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      activeSessionCount: sessionRow.count,
      accountBalance: accountRow
        ? { currency: accountRow.currency as "GAME_CREDIT", total: accountRow.total_amount, available: accountRow.available_amount, frozen: accountRow.frozen_amount }
        : null,
      recentAudit
    };
  }

  setUserFrozen(userId: string, frozen: boolean, reason: string | null, now: string): boolean {
    const result = this.database
      .prepare("UPDATE users SET frozen_at = ?, frozen_reason = ?, updated_at = ? WHERE id = ?")
      .run(frozen ? now : null, frozen ? reason : null, now, userId);
    return result.changes === 1;
  }

  revokeUserSessions(userId: string, now: string): number {
    const result = this.database
      .prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
      .run(now, userId);
    return result.changes;
  }

  // ----- 活动 -----

  getCampaign(id: string): CampaignRow | null {
    const row = this.database.prepare("SELECT * FROM admin_campaigns WHERE id = ?").get(id) as CampaignRow | undefined;
    return row ?? null;
  }

  getCampaignByCode(code: string): CampaignRow | null {
    const row = this.database.prepare("SELECT * FROM admin_campaigns WHERE code = ?").get(code) as CampaignRow | undefined;
    return row ?? null;
  }

  listCampaigns(limit: number, offset: number): { items: CampaignRow[]; total: number } {
    const total = (this.database.prepare("SELECT COUNT(*) AS count FROM admin_campaigns").get() as { count: number }).count;
    const rows = this.database.prepare("SELECT * FROM admin_campaigns ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset) as CampaignRow[];
    return { items: rows, total };
  }

  insertCampaign(row: CampaignRow): void {
    this.database
      .prepare(
        `INSERT INTO admin_campaigns (id, code, name, description, campaign_type, scope_type, scope_id, factor_bps, display_text, starts_at, ends_at, status, version, published_market_event_id, reason, created_by, created_at, updated_at, published_at, paused_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(row.id, row.code, row.name, row.description, row.campaign_type, row.scope_type, row.scope_id, row.factor_bps, row.display_text, row.starts_at, row.ends_at, row.status, row.version, row.published_market_event_id, row.reason, row.created_by, row.created_at, row.updated_at, row.published_at, row.paused_at, row.ended_at);
  }

  updateCampaignDraft(id: string, fields: { name: string; description: string | null; scope_type: CampaignScopeType; scope_id: string | null; factor_bps: number; display_text: string; starts_at: string; ends_at: string; reason: string | null; version: number; updated_at: string }): boolean {
    const result = this.database
      .prepare(
        "UPDATE admin_campaigns SET name = ?, description = ?, scope_type = ?, scope_id = ?, factor_bps = ?, display_text = ?, starts_at = ?, ends_at = ?, reason = ?, version = ?, status = 'draft', updated_at = ? WHERE id = ? AND status IN ('draft', 'previewing')"
      )
      .run(fields.name, fields.description, fields.scope_type, fields.scope_id, fields.factor_bps, fields.display_text, fields.starts_at, fields.ends_at, fields.reason, fields.version, fields.updated_at, id);
    return result.changes === 1;
  }

  appendCampaignVersion(input: { campaignId: string; version: number; definitionJson: string; statusSnapshot: CampaignStatus; createdBy: string | null; createdAt: string }): void {
    this.database
      .prepare("INSERT INTO admin_campaign_versions (id, campaign_id, version, definition_json, status_snapshot, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), input.campaignId, input.version, input.definitionJson, input.statusSnapshot, input.createdBy, input.createdAt);
  }

  /** 发布：把草稿写入只追加的 market_events，并把活动推进到 published。调用方须处于事务内。 */
  publishCampaignToMarketEvent(input: { campaignId: string; version: number; scopeType: CampaignScopeType; scopeId: string | null; factorBps: number; startsAt: string; endsAt: string; reason: string; now: string }): string {
    const marketEventId = randomUUID();
    this.database
      .prepare(
        "INSERT INTO market_events (id, scope_type, scope_id, factor_bps, starts_at, ends_at, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(marketEventId, input.scopeType, input.scopeId, input.factorBps, input.startsAt, input.endsAt, input.reason, input.now);
    this.database
      .prepare("UPDATE admin_campaigns SET status = 'published', version = ?, published_market_event_id = ?, published_at = ?, paused_at = NULL, ended_at = NULL, updated_at = ? WHERE id = ?")
      .run(input.version, marketEventId, input.now, input.now, input.campaignId);
    return marketEventId;
  }

  markCampaignPreviewing(id: string, version: number, now: string): boolean {
    const result = this.database
      .prepare("UPDATE admin_campaigns SET status = 'previewing', version = ?, updated_at = ? WHERE id = ? AND status IN ('draft', 'previewing')")
      .run(version, now, id);
    return result.changes === 1;
  }

  pauseCampaign(id: string, now: string): boolean {
    const result = this.database
      .prepare("UPDATE admin_campaigns SET status = 'paused', paused_at = ?, updated_at = ? WHERE id = ? AND status = 'published'")
      .run(now, now, id);
    return result.changes === 1;
  }

  endCampaign(id: string, now: string): boolean {
    const result = this.database
      .prepare("UPDATE admin_campaigns SET status = 'ended', ended_at = ?, updated_at = ? WHERE id = ? AND status IN ('published', 'paused')")
      .run(now, now, id);
    return result.changes === 1;
  }

  listActiveCampaignsForConflict(scopeType: CampaignScopeType, scopeId: string | null): CampaignRow[] {
    const rows = this.database
      .prepare("SELECT * FROM admin_campaigns WHERE status IN ('published', 'paused') AND scope_type = ? AND (scope_type = 'global' OR scope_id = ?)")
      .all(scopeType, scopeId ?? "") as CampaignRow[];
    return rows;
  }

  countActiveCampaigns(): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM admin_campaigns WHERE status IN ('published', 'paused')").get() as { count: number };
    return row.count;
  }

  // ----- MTGJSON 导入草稿 -----

  getImportDraft(id: string): ImportDraftRow | null {
    const row = this.database.prepare("SELECT * FROM mtgjson_import_drafts WHERE id = ?").get(id) as ImportDraftRow | undefined;
    return row ?? null;
  }

  listImportDrafts(limit: number, offset: number): { items: ImportDraftRow[]; total: number } {
    const total = (this.database.prepare("SELECT COUNT(*) AS count FROM mtgjson_import_drafts").get() as { count: number }).count;
    const rows = this.database.prepare("SELECT * FROM mtgjson_import_drafts ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset) as ImportDraftRow[];
    return { items: rows, total };
  }

  insertImportDraft(row: ImportDraftRow): void {
    this.database
      .prepare(
        `INSERT INTO mtgjson_import_drafts (id, draft_kind, source_version, source_checksum_sha256, set_code, payload_json, mapping_status, mapping_summary_json, status, version, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(row.id, row.draft_kind, row.source_version, row.source_checksum_sha256, row.set_code, row.payload_json, row.mapping_status, row.mapping_summary_json, row.status, row.version, row.created_by, row.created_at, row.updated_at);
  }

  updateImportDraftMapping(id: string, mappingStatus: MtgjsonDraftMappingStatus, mappingSummaryJson: string, now: string): boolean {
    const result = this.database
      .prepare("UPDATE mtgjson_import_drafts SET mapping_status = ?, mapping_summary_json = ?, status = 'validated', updated_at = ? WHERE id = ? AND status IN ('draft', 'validated')")
      .run(mappingStatus, mappingSummaryJson, now, id);
    return result.changes === 1;
  }

  markDraftPublished(id: string, now: string): boolean {
    const result = this.database
      .prepare("UPDATE mtgjson_import_drafts SET status = 'published', updated_at = ? WHERE id = ? AND status = 'validated' AND mapping_status = 'mapped'")
      .run(now, id);
    return result.changes === 1;
  }

  markDraftDiscarded(id: string, now: string): boolean {
    const result = this.database
      .prepare("UPDATE mtgjson_import_drafts SET status = 'discarded', updated_at = ? WHERE id = ? AND status IN ('draft', 'validated')")
      .run(now, id);
    return result.changes === 1;
  }

  // ----- 目录/价格新鲜度摘要（只读） -----

  catalogFreshness(): { updatedAt: string | null; status: "fresh" | "stale" | "unavailable" } {
    const row = this.database
      .prepare(
        "SELECT r.completed_at AS completed_at, r.status AS status FROM catalog_sync_state s JOIN catalog_sync_runs r ON r.id = s.latest_successful_run_id WHERE s.singleton = 1"
      )
      .get() as { completed_at: string | null; status: string } | undefined;
    if (!row) return { updatedAt: null, status: "unavailable" };
    return { updatedAt: row.completed_at, status: row.status === "succeeded" ? "fresh" : "stale" };
  }

  priceFreshness(): { updatedAt: string | null; status: "fresh" | "stale" | "unavailable" } {
    const row = this.database
      .prepare(
        "SELECT r.completed_at AS completed_at, r.status AS status FROM price_sync_state s JOIN price_sync_runs r ON r.id = s.latest_successful_run_id WHERE s.singleton = 1"
      )
      .get() as { completed_at: string | null; status: string } | undefined;
    if (!row) return { updatedAt: null, status: "unavailable" };
    return { updatedAt: row.completed_at, status: row.status === "succeeded" ? "fresh" : "stale" };
  }

  listLocalSets(): Array<{ code: string; name: string }> {
    const rows = this.database.prepare("SELECT code, name FROM card_sets ORDER BY code ASC").all() as Array<{ code: string; name: string }>;
    return rows;
  }

  /** I30B 系列/SKU 启停；只改 card_skus.tradable，不改目录或价格快照。人工例外来源创建延后。 */
  setSkuTradable(skuId: string, tradable: boolean, now: string): boolean {
    const result = this.database.prepare("UPDATE card_skus SET tradable = ?, updated_at = ? WHERE id = ?").run(tradable ? 1 : 0, now, skuId);
    return result.changes === 1;
  }

  listSeries(): Array<{ code: string; name: string; enabledSkuCount: number }> {
    const rows = this.database
      .prepare(
        "SELECT s.code AS code, s.name AS name, (SELECT COUNT(*) FROM card_skus sku JOIN card_printings p ON p.id = sku.printing_id WHERE p.set_id = s.id AND sku.tradable = 1) AS enabled_sku_count FROM card_sets s ORDER BY s.code ASC"
      )
      .all() as Array<{ code: string; name: string; enabled_sku_count: number }>;
    return rows.map((row) => ({ code: row.code, name: row.name, enabledSkuCount: row.enabled_sku_count }));
  }

  /** I30B MTGJSON 草稿创建：UNIQUE(draft_kind, set_code, source_version) 去重，返回是否新建。 */
  upsertImportDraft(row: ImportDraftRow): { inserted: boolean; row: ImportDraftRow } {
    const existing = this.database
      .prepare("SELECT * FROM mtgjson_import_drafts WHERE draft_kind = ? AND set_code IS ? AND source_version = ?")
      .get(row.draft_kind, row.set_code, row.source_version) as ImportDraftRow | undefined;
    if (existing) return { inserted: false, row: existing };
    this.insertImportDraft(row);
    return { inserted: true, row };
  }

  toCampaignDto = toCampaignDto;
  toImportDraftDto = toImportDraftDto;
}

function safeParseSummary(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { value: parsed };
  } catch {
    return { raw: json };
  }
}
