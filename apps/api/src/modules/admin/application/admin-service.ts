import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { withinTransaction } from "@mtg-market/database";
import type {
  AdminCampaignDto,
  AdminCampaignPreviewDto,
  AdminCompensationResultDto,
  AdminDashboardDto,
  AdminExceptionTradeDto,
  AdminMarketParametersDto,
  AdminUserDetailDto,
  AdminUserListItemDto,
  AdminAuditLogDto,
  AdminAuditLogDetailDto,
  ApiResponse,
  MtgjsonImportDraftDto,
  MtgjsonImportDraftSummaryDto,
  Page
} from "@mtg-market/contracts";
import { failure, success } from "../../../shared/http/api-response.js";
import { enqueueMarketRepriceJob } from "../../jobs/application/task-service.js";
import { SqliteJobRepository } from "../../jobs/infrastructure/sqlite-job-repository.js";
import { InventoryService } from "../../inventory/application/inventory-service.js";
import { UserService } from "../../users/application/user-service.js";
import { PackService } from "../../packs/application/pack-service.js";
import {
  SqliteAdminRepository,
  type AuditLogFilters,
  type CampaignRow,
  type ImportDraftRow
} from "../infrastructure/sqlite-admin-repository.js";
import {
  SqliteMarketParametersRepository,
  type UpdateMarketParametersInput
} from "../infrastructure/sqlite-market-parameters-repository.js";
import type { InventoryAdjustment } from "../../inventory/domain/inventory.js";
import {
  campaignRequestFingerprint,
  detectCampaignConflicts,
  validateCampaignDefinition,
  type CampaignConflictCandidate
} from "../domain/campaign.js";
import {
  compensationRequestFingerprint,
  validateCompensationInput,
  type CompensationDirection
} from "../domain/compensation.js";
import {
  importDraftRequestFingerprint,
  resolveDraftMapping,
  validateSetlistEntries
} from "../domain/import-draft.js";

/**
 * I30B 管理后台 application。所有写用例在单个 SQLite 短事务内完成幂等 + 审计 + 跨模块协作；
 * 经济补偿通过 users/inventory application 端口追加流水，绝不直接覆盖余额/库存或删除原流水。
 * AdminModule 不跨模块直写 users/accounts/inventory 表（用户冻结、会话撤销除外）。
 */

export type AdminWriteResult<T> =
  | { state: "replayed"; statusCode: number; response: ApiResponse<T> }
  | { state: "conflict" }
  | { state: "in-progress" }
  | { state: "completed"; statusCode: number; response: ApiResponse<T> };

export type AdminErrorResult =
  | { state: "not-found" }
  | { state: "version-stale" }
  | { state: "validation"; code: string; message: string }
  | { state: "entity-conflict"; message: string };

export interface AdminServiceDeps {
  environment: "development" | "test" | "production";
}

export class AdminService {
  private readonly admin: SqliteAdminRepository;
  private readonly marketParameters: SqliteMarketParametersRepository;
  private readonly users: UserService;
  private readonly inventory: InventoryService;
  private readonly packs: PackService;
  private readonly jobs: SqliteJobRepository;
  constructor(private readonly database: Database.Database, private readonly deps: AdminServiceDeps) {
    this.admin = new SqliteAdminRepository(database);
    this.marketParameters = new SqliteMarketParametersRepository(database);
    this.users = new UserService(database);
    this.inventory = new InventoryService(database);
    this.packs = new PackService(database);
    this.jobs = new SqliteJobRepository(database);
  }

  // ----- 后台首页与日志（只读） -----

  dashboard(): AdminDashboardDto {
    return {
      environment: this.deps.environment,
      catalogFreshness: this.admin.catalogFreshness(),
      priceFreshness: this.admin.priceFreshness(),
      failedJobCount: this.admin.countFailedJobs(),
      activeCampaignCount: this.admin.countActiveCampaigns(),
      pendingReviewExceptionCount: this.admin.listExceptionTrades(100).length,
      recentActions: this.admin.listRecentActions(10)
    };
  }

  listAuditLogs(filters: AuditLogFilters, cursor: string | undefined, limit: number): Page<AdminAuditLogDto> {
    return this.admin.listAuditLogs(filters, cursor, limit);
  }

  getAuditLog(id: string): AdminAuditLogDetailDto | null {
    const log = this.admin.getAuditLog(id);
    if (!log) return null;
    return { ...log, relatedLogs: this.admin.listRelatedLogs(log.entityType, log.entityId, 10) };
  }

  listExceptionTrades(limit: number): AdminExceptionTradeDto[] {
    return this.admin.listExceptionTrades(limit);
  }

  // ----- 活动 -----

  saveCampaignDraft(input: { code: string; name: string; description: string | null; campaignType: "market_factor"; scopeType: "global" | "set" | "sku"; scopeId: string | null; factorBps: number; displayText: string; startsAt: string; endsAt: string; reason: string | null; actorId: string; idempotencyKey: string; requestId: string; now: string }): AdminWriteResult<AdminCampaignDto> | AdminErrorResult {
    const body = { code: input.code, name: input.name, scopeType: input.scopeType, scopeId: input.scopeId, factorBps: input.factorBps, startsAt: input.startsAt, endsAt: input.endsAt, displayText: input.displayText, reason: input.reason, description: input.description };
    return this.runIdempotent(input.actorId, input.idempotencyKey, input.requestId, input.now, body, (complete) => {
      const issues = validateCampaignDefinition({ campaignType: input.campaignType, scopeType: input.scopeType, scopeId: input.scopeId, factorBps: input.factorBps, startsAt: input.startsAt, endsAt: input.endsAt, displayText: input.displayText, name: input.name, code: input.code, description: input.description, reason: input.reason });
      if (issues.length > 0) return complete(400, failure(input.requestId, "VALIDATION_FAILED", `活动定义校验失败：${issues.join(",")}`));
      return withinTransaction(this.database, () => {
        const existing = this.admin.getCampaignByCode(input.code);
        if (existing) return complete(409, failure(input.requestId, "RESOURCE_CONFLICT", "活动代码已存在"));
        const id = randomUUID();
        const row: CampaignRow = {
          id, code: input.code, name: input.name, description: input.description, campaign_type: input.campaignType,
          scope_type: input.scopeType, scope_id: input.scopeId, factor_bps: input.factorBps, display_text: input.displayText,
          starts_at: input.startsAt, ends_at: input.endsAt, status: "draft", version: 1, published_market_event_id: null,
          reason: input.reason, created_by: input.actorId, created_at: input.now, updated_at: input.now,
          published_at: null, paused_at: null, ended_at: null
        };
        this.admin.insertCampaign(row);
        this.admin.appendCampaignVersion({ campaignId: id, version: 1, definitionJson: JSON.stringify(body), statusSnapshot: "draft", createdBy: input.actorId, createdAt: input.now });
        this.writeAudit(input.actorId, "campaign.draft_saved", "campaign", id, input.requestId, { campaignId: id, code: input.code }, input.now);
        return complete(201, success(input.requestId, this.admin.toCampaignDto(this.admin.getCampaign(id)!)));
      });
    });
  }

  listCampaigns(limit: number, offset: number): { items: AdminCampaignDto[]; total: number } {
    const { items, total } = this.admin.listCampaigns(limit, offset);
    return { items: items.map((row) => this.admin.toCampaignDto(row)), total };
  }

  getCampaign(id: string): AdminCampaignDto | null {
    const row = this.admin.getCampaign(id);
    return row ? this.admin.toCampaignDto(row) : null;
  }

  previewCampaign(id: string, now: string): AdminCampaignPreviewDto | AdminErrorResult {
    const row = this.admin.getCampaign(id);
    if (!row) return { state: "not-found" };
    const active = this.admin.listActiveCampaignsForConflict(row.scope_type, row.scope_id).map(toConflictCandidate);
    const conflicts = detectCampaignConflicts({ scopeType: row.scope_type, scopeId: row.scope_id, startsAt: row.starts_at, endsAt: row.ends_at }, active)
      .filter((candidate) => candidate.campaignId !== row.id)
      .map((candidate) => ({ campaignId: candidate.campaignId, code: candidate.code, scopeType: candidate.scopeType, scopeId: candidate.scopeId, startsAt: candidate.startsAt, endsAt: candidate.endsAt }));
    const previewVersion = row.version + 1;
    this.admin.markCampaignPreviewing(id, previewVersion, now);
    const updated = this.admin.getCampaign(id)!;
    return {
      campaign: this.admin.toCampaignDto(updated),
      previewVersion,
      conflicts,
      factorBpsInRange: row.factor_bps >= 5000 && row.factor_bps <= 20000,
      scheduledReprice: { triggerKey: `activity:${row.id}:${previewVersion}`, runAfter: now }
    };
  }

  publishCampaign(input: { campaignId: string; previewVersion: number; actorId: string; idempotencyKey: string; requestId: string; now: string }): AdminWriteResult<AdminCampaignDto> | AdminErrorResult {
    return this.runIdempotent(input.actorId, input.idempotencyKey, input.requestId, input.now, { campaignId: input.campaignId, previewVersion: input.previewVersion }, (complete) => {
      return withinTransaction(this.database, () => {
        const row = this.admin.getCampaign(input.campaignId);
        if (!row) return complete(404, failure(input.requestId, "RESOURCE_NOT_FOUND", "活动不存在"));
        // 预览已把版本推进到 previewVersion；提交时必须携带同一 previewVersion，否则版本过期。
        if (row.version !== input.previewVersion) return complete(409, failure(input.requestId, "VERSION_STALE", "活动版本已变更，请重新预览"));
        const issues = validateCampaignDefinition(toDefinitionInput(row));
        if (issues.length > 0) return complete(409, failure(input.requestId, "RULE_VIOLATION", `活动定义校验失败：${issues.join(",")}`));
        const active = this.admin.listActiveCampaignsForConflict(row.scope_type, row.scope_id).filter((candidate) => candidate.id !== row.id).map(toConflictCandidate);
        const conflicts = detectCampaignConflicts({ scopeType: row.scope_type, scopeId: row.scope_id, startsAt: row.starts_at, endsAt: row.ends_at }, active);
        if (conflicts.length > 0) return complete(409, failure(input.requestId, "RESOURCE_CONFLICT", "活动作用域或区间与已发布活动冲突"));
        const marketEventId = this.admin.publishCampaignToMarketEvent({
          campaignId: row.id,
          version: input.previewVersion,
          scopeType: row.scope_type,
          scopeId: row.scope_id,
          factorBps: row.factor_bps,
          startsAt: row.starts_at,
          endsAt: row.ends_at,
          reason: `活动发布：${row.code}`,
          now: input.now
        });
        this.admin.appendCampaignVersion({ campaignId: row.id, version: input.previewVersion, definitionJson: JSON.stringify(toDefinitionInput(row)), statusSnapshot: "published", createdBy: input.actorId, createdAt: input.now });
        enqueueMarketRepriceJob(this.database, `activity:${row.id}:${input.previewVersion}`, input.now);
        this.writeAudit(input.actorId, "campaign.published", "campaign", row.id, input.requestId, { campaignId: row.id, code: row.code, marketEventId, version: input.previewVersion }, input.now);
        const updated = this.admin.getCampaign(input.campaignId)!;
        return complete(200, success(input.requestId, this.admin.toCampaignDto(updated)));
      });
    });
  }

  pauseCampaign(input: { campaignId: string; actorId: string; idempotencyKey: string; requestId: string; now: string }): AdminWriteResult<AdminCampaignDto> | AdminErrorResult {
    return this.runIdempotent(input.actorId, input.idempotencyKey, input.requestId, input.now, { campaignId: input.campaignId }, (complete) => {
      return withinTransaction(this.database, () => {
        const paused = this.admin.pauseCampaign(input.campaignId, input.now);
        if (!paused) return complete(409, failure(input.requestId, "RESOURCE_CONFLICT", "活动不在 published 状态，无法暂停"));
        this.writeAudit(input.actorId, "campaign.paused", "campaign", input.campaignId, input.requestId, { campaignId: input.campaignId }, input.now);
        const updated = this.admin.getCampaign(input.campaignId)!;
        return complete(200, success(input.requestId, this.admin.toCampaignDto(updated)));
      });
    });
  }

  endCampaign(input: { campaignId: string; actorId: string; idempotencyKey: string; requestId: string; now: string }): AdminWriteResult<AdminCampaignDto> | AdminErrorResult {
    return this.runIdempotent(input.actorId, input.idempotencyKey, input.requestId, input.now, { campaignId: input.campaignId }, (complete) => {
      return withinTransaction(this.database, () => {
        const ended = this.admin.endCampaign(input.campaignId, input.now);
        if (!ended) return complete(409, failure(input.requestId, "RESOURCE_CONFLICT", "活动不在 published/paused 状态，无法结束"));
        this.writeAudit(input.actorId, "campaign.ended", "campaign", input.campaignId, input.requestId, { campaignId: input.campaignId }, input.now);
        const updated = this.admin.getCampaign(input.campaignId)!;
        return complete(200, success(input.requestId, this.admin.toCampaignDto(updated)));
      });
    });
  }

  // ----- 用户管理 -----

  searchUsers(query: { userId?: string | undefined; username?: string | undefined; role?: string | undefined; status?: "active" | "frozen" | undefined }, limit: number, offset: number): { items: AdminUserListItemDto[]; total: number } {
    return this.admin.searchUsers(query, limit, offset);
  }

  getUserDetail(userId: string): AdminUserDetailDto | null {
    return this.admin.getUserDetail(userId);
  }

  freezeUser(input: { userId: string; reason: string; actorId: string; idempotencyKey: string; requestId: string; now: string }): AdminWriteResult<{ userId: string; frozen: boolean }> | AdminErrorResult {
    return this.runIdempotent(input.actorId, input.idempotencyKey, input.requestId, input.now, { userId: input.userId, reason: input.reason }, (complete) => {
      return withinTransaction(this.database, () => {
        if (!input.reason || input.reason.trim().length === 0) return complete(400, failure(input.requestId, "VALIDATION_FAILED", "冻结原因必填"));
        const updated = this.admin.setUserFrozen(input.userId, true, input.reason, input.now);
        if (!updated) return complete(404, failure(input.requestId, "RESOURCE_NOT_FOUND", "用户不存在"));
        this.writeAudit(input.actorId, "user.frozen", "user", input.userId, input.requestId, { userId: input.userId, reason: input.reason }, input.now);
        return complete(200, success(input.requestId, { userId: input.userId, frozen: true }));
      });
    });
  }

  unfreezeUser(input: { userId: string; actorId: string; idempotencyKey: string; requestId: string; now: string }): AdminWriteResult<{ userId: string; frozen: boolean }> | AdminErrorResult {
    return this.runIdempotent(input.actorId, input.idempotencyKey, input.requestId, input.now, { userId: input.userId }, (complete) => {
      return withinTransaction(this.database, () => {
        const updated = this.admin.setUserFrozen(input.userId, false, null, input.now);
        if (!updated) return complete(404, failure(input.requestId, "RESOURCE_NOT_FOUND", "用户不存在"));
        this.writeAudit(input.actorId, "user.unfrozen", "user", input.userId, input.requestId, { userId: input.userId }, input.now);
        return complete(200, success(input.requestId, { userId: input.userId, frozen: false }));
      });
    });
  }

  revokeUserSessions(input: { userId: string; actorId: string; idempotencyKey: string; requestId: string; now: string }): AdminWriteResult<{ userId: string; revokedCount: number }> | AdminErrorResult {
    return this.runIdempotent(input.actorId, input.idempotencyKey, input.requestId, input.now, { userId: input.userId }, (complete) => {
      return withinTransaction(this.database, () => {
        const count = this.admin.revokeUserSessions(input.userId, input.now);
        this.writeAudit(input.actorId, "user.sessions_revoked", "user", input.userId, input.requestId, { userId: input.userId, revokedCount: count }, input.now);
        return complete(200, success(input.requestId, { userId: input.userId, revokedCount: count }));
      });
    });
  }

  compensateBalance(input: { userId: string; amount: number; direction: CompensationDirection; reason: string; actorId: string; idempotencyKey: string; requestId: string; now: string }): AdminWriteResult<AdminCompensationResultDto> | AdminErrorResult {
    const fingerprint = compensationRequestFingerprint({ userId: input.userId, amount: input.amount, direction: input.direction, reason: input.reason });
    return this.runIdempotentWithFingerprint(input.actorId, input.idempotencyKey, fingerprint, input.requestId, input.now, (complete) => {
      const issues = validateCompensationInput({ kind: "balance", amount: input.amount, reason: input.reason, direction: input.direction });
      if (issues.length > 0) return complete(400, failure(input.requestId, "VALIDATION_FAILED", `补偿校验失败：${issues.join(",")}`));
      return withinTransaction(this.database, () => {
        const correlationId = `admin-compensation:${input.idempotencyKey}`;
        const funds = this.users.funds();
        const balance = funds.getBalance(input.userId);
        if (!balance) return complete(404, failure(input.requestId, "RESOURCE_NOT_FOUND", "用户账户不存在"));
        const magnitude = Math.abs(input.amount);
        let newBalance;
        if (input.direction === "credit") {
          newBalance = funds.creditAvailableFunds(input.userId, magnitude, input.now, correlationId, "admin_compensation");
          if (newBalance === "missing") return complete(404, failure(input.requestId, "RESOURCE_NOT_FOUND", "用户账户不存在"));
        } else {
          if (balance.available.amount < magnitude) return complete(409, failure(input.requestId, "INSUFFICIENT_BALANCE", "可用余额不足，补偿未执行"));
          newBalance = funds.spendAvailableFunds(input.userId, magnitude, input.now, correlationId, "admin_compensation");
          if (newBalance === "insufficient") return complete(409, failure(input.requestId, "INSUFFICIENT_BALANCE", "可用余额不足，补偿未执行"));
        }
        const ledgerEntry = this.database.prepare("SELECT id FROM ledger_entries WHERE correlation_id = ? ORDER BY occurred_at DESC LIMIT 1").get(correlationId) as { id: string } | undefined;
        const auditId = randomUUID();
        this.database.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, request_id, summary_json, occurred_at) VALUES (?, ?, 'user.balance_compensated', 'user', ?, ?, ?, ?)").run(auditId, input.actorId, input.userId, input.requestId, JSON.stringify({ userId: input.userId, direction: input.direction, amount: magnitude, reason: input.reason, ledgerEntryId: ledgerEntry?.id ?? null }), input.now);
        return complete(200, success(input.requestId, {
          userId: input.userId,
          ledgerEntryId: ledgerEntry?.id ?? null,
          inventoryEntryId: null,
          newBalance: { currency: newBalance.total.currency, total: newBalance.total.amount, available: newBalance.available.amount, frozen: newBalance.frozen.amount },
          newQuantity: null,
          auditId,
          reason: input.reason
        }));
      });
    });
  }

  compensateInventory(input: { userId: string; skuId: string; quantity: number; direction: CompensationDirection; reason: string; actorId: string; idempotencyKey: string; requestId: string; now: string }): AdminWriteResult<AdminCompensationResultDto> | AdminErrorResult {
    const fingerprint = compensationRequestFingerprint({ userId: input.userId, skuId: input.skuId, quantity: input.quantity, direction: input.direction, reason: input.reason });
    return this.runIdempotentWithFingerprint(input.actorId, input.idempotencyKey, fingerprint, input.requestId, input.now, (complete) => {
      const issues = validateCompensationInput({ kind: "inventory", amount: input.quantity, reason: input.reason, direction: input.direction });
      if (issues.length > 0) return complete(400, failure(input.requestId, "VALIDATION_FAILED", `补偿校验失败：${issues.join(",")}`));
      return this.inventory.withLedgerTransaction((inventory) => {
        const correlationId = `admin-compensation:${input.idempotencyKey}`;
        const magnitude = Math.abs(input.quantity);
        const delta = input.direction === "credit" ? magnitude : -magnitude;
        const adjustment: InventoryAdjustment = { userId: input.userId, skuId: input.skuId, quantityDelta: delta, reason: "admin_compensation", correlationId, now: input.now };
        if (input.direction === "credit") adjustment.unitCostAmount = 0;
        const result = inventory.adjust(adjustment);
        if (result === "insufficient") return complete(409, failure(input.requestId, "INSUFFICIENT_INVENTORY", "可用库存不足，补偿未执行"));
        const entry = this.database.prepare("SELECT id FROM inventory_entries WHERE correlation_id = ? ORDER BY occurred_at DESC LIMIT 1").get(correlationId) as { id: string } | undefined;
        const auditId = randomUUID();
        this.database.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, request_id, summary_json, occurred_at) VALUES (?, ?, 'user.inventory_compensated', 'user', ?, ?, ?, ?)").run(auditId, input.actorId, input.userId, input.requestId, JSON.stringify({ userId: input.userId, skuId: input.skuId, direction: input.direction, quantity: magnitude, reason: input.reason, inventoryEntryId: entry?.id ?? null }), input.now);
        return complete(200, success(input.requestId, {
          userId: input.userId,
          ledgerEntryId: null,
          inventoryEntryId: entry?.id ?? null,
          newBalance: null,
          newQuantity: { skuId: input.skuId, quantity: result.quantity, available: result.availableQuantity, orderLocked: result.orderLockedQuantity, tournamentLocked: result.tournamentLockedQuantity },
          auditId,
          reason: input.reason
        }));
      });
    });
  }

  // ----- 市场参数 -----

  getMarketParameters(): AdminMarketParametersDto | null {
    const row = this.marketParameters.get();
    return row ? this.marketParameters.toDto(row) : null;
  }

  updateMarketParameters(input: { eurCentToGameCreditBps: number; minimumPrice: number; npcBuySpreadBps: number; npcSellSpreadBps: number; npcFeeBps: number; expectedVersion: number; actorId: string; idempotencyKey: string; requestId: string; now: string }): AdminWriteResult<AdminMarketParametersDto> | AdminErrorResult {
    return this.runIdempotent(input.actorId, input.idempotencyKey, input.requestId, input.now, input, (complete) => {
      return withinTransaction(this.database, () => {
        const updateInput: UpdateMarketParametersInput = { eurCentToGameCreditBps: input.eurCentToGameCreditBps, minimumPrice: input.minimumPrice, npcBuySpreadBps: input.npcBuySpreadBps, npcSellSpreadBps: input.npcSellSpreadBps, npcFeeBps: input.npcFeeBps, expectedVersion: input.expectedVersion, now: input.now };
        const result = this.marketParameters.update(updateInput);
        if (result === "stale") return complete(409, failure(input.requestId, "VERSION_STALE", "市场参数版本已变更，请重新预览"));
        enqueueMarketRepriceJob(this.database, `market-parameters:${input.now}`, input.now);
        this.writeAudit(input.actorId, "market_parameters.updated", "market_parameters", "singleton", input.requestId, { parameters: updateInput }, input.now);
        return complete(200, success(input.requestId, this.marketParameters.toDto(result)));
      });
    });
  }

  // ----- 任务重试 -----

  retryJob(jobId: string, now: string) {
    return this.jobs.manualRetry(jobId, now);
  }

  // ----- 系列/SKU 启停与同步触发（不直接改目录或价格快照，仅切换 tradable 或投递受控任务） -----

  listSeries(): Array<{ code: string; name: string; enabledSkuCount: number }> {
    return this.admin.listSeries();
  }

  setSkuTradable(input: { skuId: string; tradable: boolean; actorId: string; idempotencyKey: string; requestId: string; now: string }): AdminWriteResult<{ skuId: string; tradable: boolean }> | AdminErrorResult {
    return this.runIdempotent(input.actorId, input.idempotencyKey, input.requestId, input.now, { skuId: input.skuId, tradable: input.tradable }, (complete) => {
      return withinTransaction(this.database, () => {
        const updated = this.admin.setSkuTradable(input.skuId, input.tradable, input.now);
        if (!updated) return complete(404, failure(input.requestId, "RESOURCE_NOT_FOUND", "SKU 不存在"));
        this.writeAudit(input.actorId, "sku.tradable_updated", "card_sku", input.skuId, input.requestId, { skuId: input.skuId, tradable: input.tradable }, input.now);
        return complete(200, success(input.requestId, { skuId: input.skuId, tradable: input.tradable }));
      });
    });
  }

  triggerCatalogSync(input: { actorId: string; idempotencyKey: string; requestId: string; now: string }): { jobId: string } {
    const job = this.jobs.enqueue({ type: "catalog.sync", payload: {}, uniqueKey: `catalog.sync:${input.idempotencyKey}`, runAfter: input.now, maxAttempts: 3 }, input.now);
    this.writeAudit(input.actorId, "catalog.sync_triggered", "job", job.id, input.requestId, { taskType: job.type }, input.now);
    return { jobId: job.id };
  }

  triggerPriceSync(input: { actorId: string; idempotencyKey: string; requestId: string; now: string }): { jobId: string } {
    const job = this.jobs.enqueue({ type: "prices.sync", payload: {}, uniqueKey: `prices.sync:${input.idempotencyKey}`, runAfter: input.now, maxAttempts: 3 }, input.now);
    this.writeAudit(input.actorId, "prices.sync_triggered", "job", job.id, input.requestId, { taskType: job.type }, input.now);
    return { jobId: job.id };
  }

  // ----- 活动定时发布（以 starts_at 投递 runAfter，复用发布命令） -----

  scheduleCampaign(input: { campaignId: string; previewVersion: number; actorId: string; idempotencyKey: string; requestId: string; now: string }): AdminWriteResult<AdminCampaignDto> | AdminErrorResult {
    const row = this.admin.getCampaign(input.campaignId);
    if (!row) return { state: "not-found" };
    if (row.version !== input.previewVersion) return { state: "version-stale" };
    // 定时发布以 starts_at 作为 runAfter 投递 market.reprice；活动本身先保持 previewing，
    // 由发布命令在到点后由后台或管理员显式发布。这里只投递定时重价任务并审计。
    return this.runIdempotent(input.actorId, input.idempotencyKey, input.requestId, input.now, { campaignId: input.campaignId, previewVersion: input.previewVersion }, (complete) => {
      return withinTransaction(this.database, () => {
        enqueueMarketRepriceJob(this.database, `activity:${input.campaignId}:${input.previewVersion}`, row.starts_at);
        this.writeAudit(input.actorId, "campaign.scheduled", "campaign", input.campaignId, input.requestId, { campaignId: input.campaignId, previewVersion: input.previewVersion, runAfter: row.starts_at }, input.now);
        return complete(200, success(input.requestId, this.admin.toCampaignDto(this.admin.getCampaign(input.campaignId)!)));
      });
    });
  }

  // ----- MTGJSON 导入草稿 -----

  /**
   * 创建 SetList 导入草稿。管理员提交来源版本、可选 checksum 与已校验的 setlist 条目；
   * 服务端只保存草稿与映射摘要，绝不直接改写目录、库存或价格快照。
   * UNIQUE(draft_kind, set_code, source_version) 保证同源重放返回首次草稿。
   */
  createSetlistDraft(input: { sourceVersion: string; sourceChecksumSha256: string | null; setlist: unknown[]; actorId: string; idempotencyKey: string; requestId: string; now: string }): AdminWriteResult<MtgjsonImportDraftDto> | AdminErrorResult {
    const body = { sourceVersion: input.sourceVersion, sourceChecksumSha256: input.sourceChecksumSha256, setlistCount: input.setlist.length };
    return this.runIdempotent(input.actorId, input.idempotencyKey, input.requestId, input.now, body, (complete) => {
      const entries = validateSetlistEntries(input.setlist);
      if (entries.length === 0) return complete(400, failure(input.requestId, "VALIDATION_FAILED", "SetList 无有效条目"));
      return withinTransaction(this.database, () => {
        const id = randomUUID();
        const row: ImportDraftRow = {
          id, draft_kind: "setlist", source_version: input.sourceVersion, source_checksum_sha256: input.sourceChecksumSha256,
          set_code: null, payload_json: JSON.stringify({ setlist: entries }), mapping_status: "pending", mapping_summary_json: null,
          status: "draft", version: 1, created_by: input.actorId, created_at: input.now, updated_at: input.now
        };
        const { inserted, row: finalRow } = this.admin.upsertImportDraft(row);
        this.writeAudit(input.actorId, "mtgjson_setlist_draft.created", "mtgjson_import_draft", finalRow.id, input.requestId, { draftId: finalRow.id, sourceVersion: input.sourceVersion, checksum: input.sourceChecksumSha256, newDraft: inserted }, input.now);
        return complete(inserted ? 201 : 200, success(input.requestId, this.admin.toImportDraftDto(finalRow)));
      });
    });
  }

  listImportDrafts(limit: number, offset: number): { items: MtgjsonImportDraftDto[]; total: number } {
    const { items, total } = this.admin.listImportDrafts(limit, offset);
    return { items: items.map((row) => this.admin.toImportDraftDto(row)), total };
  }

  getImportDraft(id: string): MtgjsonImportDraftDto | null {
    const row = this.admin.getImportDraft(id);
    return row ? this.admin.toImportDraftDto(row) : null;
  }

  previewImportDraft(id: string, now: string): MtgjsonImportDraftSummaryDto | AdminErrorResult {
    const row = this.admin.getImportDraft(id);
    if (!row) return { state: "not-found" };
    const payload = JSON.parse(row.payload_json) as { setlist?: unknown[] };
    const setlist = validateSetlistEntries(payload.setlist ?? []);
    const localSets = this.admin.listLocalSets();
    const mapping = resolveDraftMapping(setlist, localSets);
    this.admin.updateImportDraftMapping(id, mapping.mappingStatus, JSON.stringify({ importableCount: mapping.importableCount, missingCount: mapping.missingCount, conflictCount: mapping.conflictCount, items: mapping.items }), now);
    const updated = this.admin.getImportDraft(id)!;
    return {
      draft: this.admin.toImportDraftDto(updated),
      importableCount: mapping.importableCount,
      missingCount: mapping.missingCount,
      conflictCount: mapping.conflictCount,
      items: mapping.items
    };
  }

  discardDraft(input: { draftId: string; actorId: string; idempotencyKey: string; requestId: string; now: string }): AdminWriteResult<MtgjsonImportDraftDto> | AdminErrorResult {
    return this.runIdempotent(input.actorId, input.idempotencyKey, input.requestId, input.now, { draftId: input.draftId }, (complete) => {
      return withinTransaction(this.database, () => {
        const discarded = this.admin.markDraftDiscarded(input.draftId, input.now);
        if (!discarded) return complete(409, failure(input.requestId, "RESOURCE_CONFLICT", "草稿状态不允许丢弃"));
        this.writeAudit(input.actorId, "mtgjson_draft.discarded", "mtgjson_import_draft", input.draftId, input.requestId, { draftId: input.draftId }, input.now);
        const updated = this.admin.getImportDraft(input.draftId)!;
        return complete(200, success(input.requestId, this.admin.toImportDraftDto(updated)));
      });
    });
  }

  // ----- 补充包规则 -----

  previewPackRule(packId: string, definition: unknown) {
    return this.packs.previewRule(packId, definition as Parameters<PackService["previewRule"]>[1]);
  }

  publishPackRule(input: { packId: string; definition: unknown; actorId: string; idempotencyKey: string; requestId: string; now: string }): AdminWriteResult<{ packId: string; ruleVersion: string }> | AdminErrorResult {
    const fingerprint = importDraftRequestFingerprint({ packId: input.packId, definition: input.definition });
    return this.runIdempotentWithFingerprint(input.actorId, input.idempotencyKey, fingerprint, input.requestId, input.now, (complete) => {
      return withinTransaction(this.database, () => {
        const result = this.packs.publishRule(input.packId, input.definition as Parameters<PackService["publishRule"]>[1], input.now);
        if (result === "not-found") return complete(404, failure(input.requestId, "RESOURCE_NOT_FOUND", "补充包不存在"));
        if (result === "version-conflict") return complete(409, failure(input.requestId, "RESOURCE_CONFLICT", "规则版本已存在，不可原地覆盖"));
        this.writeAudit(input.actorId, "pack_rule.published", "booster_pack", input.packId, input.requestId, { packId: input.packId, ruleVersion: result }, input.now);
        return complete(201, success(input.requestId, { packId: input.packId, ruleVersion: result }));
      });
    });
  }

  disablePack(input: { packId: string; reason: string; actorId: string; idempotencyKey: string; requestId: string; now: string }): AdminWriteResult<{ packId: string; enabled: boolean }> | AdminErrorResult {
    return this.runIdempotent(input.actorId, input.idempotencyKey, input.requestId, input.now, { packId: input.packId, reason: input.reason }, (complete) => {
      return withinTransaction(this.database, () => {
        const disabled = this.packs.disablePack(input.packId, input.reason, input.now);
        if (!disabled) return complete(409, failure(input.requestId, "RESOURCE_CONFLICT", "补充包已停用或不存在"));
        this.writeAudit(input.actorId, "pack.disabled", "booster_pack", input.packId, input.requestId, { packId: input.packId, reason: input.reason }, input.now);
        return complete(200, success(input.requestId, { packId: input.packId, enabled: false }));
      });
    });
  }

  // ----- 内部：幂等编排 -----

  private runIdempotent<T>(
    actorId: string,
    idempotencyKey: string,
    requestId: string,
    now: string,
    body: unknown,
    operation: (complete: (status: number, response: ApiResponse<T>) => ApiResponse<T>) => ApiResponse<T>
  ): AdminWriteResult<T> | AdminErrorResult {
    const fingerprint = campaignRequestFingerprint(body);
    return this.runIdempotentWithFingerprint(actorId, idempotencyKey, fingerprint, requestId, now, operation);
  }

  private runIdempotentWithFingerprint<T>(
    actorId: string,
    idempotencyKey: string,
    fingerprint: string,
    requestId: string,
    now: string,
    operation: (complete: (status: number, response: ApiResponse<T>) => ApiResponse<T>) => ApiResponse<T>
  ): AdminWriteResult<T> | AdminErrorResult {
    const existing = this.admin.findIdempotency(actorId, idempotencyKey);
    if (existing) {
      if (existing.request_fingerprint !== fingerprint) return { state: "conflict" };
      if (existing.status !== "completed" || !existing.response_json) return { state: "in-progress" };
      return { state: "replayed", statusCode: existing.response_status ?? 200, response: JSON.parse(existing.response_json) as ApiResponse<T> };
    }
    const beginResult = this.admin.beginIdempotency(actorId, idempotencyKey, fingerprint, now);
    if (beginResult === "conflict") {
      const retry = this.admin.findIdempotency(actorId, idempotencyKey);
      if (retry) {
        if (retry.request_fingerprint !== fingerprint) return { state: "conflict" };
        if (retry.status !== "completed" || !retry.response_json) return { state: "in-progress" };
        return { state: "replayed", statusCode: retry.response_status ?? 200, response: JSON.parse(retry.response_json) as ApiResponse<T> };
      }
    }
    let responseStatus = 500;
    let responseJson = "";
    const complete = (status: number, response: ApiResponse<T>): ApiResponse<T> => {
      responseStatus = status;
      responseJson = JSON.stringify(response);
      return response;
    };
    const response = operation(complete);
    this.admin.completeIdempotency(actorId, idempotencyKey, responseStatus, responseJson, now);
    return { state: "completed", statusCode: responseStatus, response };
  }

  private writeAudit(actorId: string, action: string, entityType: string, entityId: string, requestId: string, summary: Record<string, unknown>, now: string): void {
    this.database.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, request_id, summary_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), actorId, action, entityType, entityId, requestId, JSON.stringify(summary), now);
  }
}

function toDefinitionInput(row: CampaignRow) {
  return {
    campaignType: row.campaign_type,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    factorBps: row.factor_bps,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    displayText: row.display_text,
    name: row.name,
    code: row.code,
    description: row.description,
    reason: row.reason
  };
}

function toConflictCandidate(row: CampaignRow): CampaignConflictCandidate {
  return { campaignId: row.id, code: row.code, scopeType: row.scope_type, scopeId: row.scope_id, startsAt: row.starts_at, endsAt: row.ends_at };
}
