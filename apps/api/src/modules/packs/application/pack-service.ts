import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { openPack, packSlotProbabilities, type PackOpenResult } from "@mtg-market/rules";
import {
  canonicalizeRequest,
  type ApiResponse,
  type PackDto,
  type PackOpeningCardDto,
  type PackOpeningDto,
  type PackPurchasePreviewDto,
  type Page
} from "@mtg-market/contracts";
import { withinTransaction } from "@mtg-market/database";
import {
  SqlitePackRepository,
  type StoredPackConfiguration
} from "../infrastructure/sqlite-pack-repository.js";
import { InventoryService } from "../../inventory/application/inventory-service.js";
import { UserService } from "../../users/application/user-service.js";
import { failure, success } from "../../../shared/http/api-response.js";

function toPackDto(pack: StoredPackConfiguration): PackDto {
  return {
    id: pack.id,
    code: pack.code,
    name: pack.name,
    description: pack.description,
    price: { amount: pack.price_amount, currency: "GAME_CREDIT" },
    enabled: pack.enabled === 1,
    disabledReason: pack.disabled_reason,
    ruleVersion: pack.active_rule_version,
    slots: packSlotProbabilities(pack.definition).map((slot) => ({
      id: slot.slotId,
      draws: slot.draws,
      rarityProbabilities: slot.rarityProbabilities
    })),
    updatedAt: pack.updated_at
  };
}

export type PackRuleReplayResult = {
  replayId: string;
  randomSeedHash: string;
  result: PackOpenResult;
};
export type PackOpeningCommandResult =
  | { state: "completed"; statusCode: number; response: ApiResponse<{ opening: PackOpeningDto }> }
  | { state: "replayed"; statusCode: number; response: ApiResponse<{ opening: PackOpeningDto }> }
  | { state: "conflict" }
  | { state: "in-progress" };

type IdempotencyRow = {
  request_fingerprint: string;
  status: string;
  response_status: number | null;
  response_json: string | null;
};

/**
 * I11B 只提供配置读取与随机审计。I12B 会在同一经济短事务中调用此规则并追加扣款、
 * 库存、事实事件及幂等结果；这里没有对浏览器开放开奖命令。
 */
export class PackService {
  private readonly packs: SqlitePackRepository;
  private readonly inventory: InventoryService;
  private readonly users: UserService;
  constructor(
    private readonly database: Database.Database,
    private readonly createSeed: () => string = () => randomBytes(32).toString("hex")
  ) {
    this.packs = new SqlitePackRepository(database);
    this.inventory = new InventoryService(database);
    this.users = new UserService(database);
  }

  list(): PackDto[] {
    return this.packs.list().map(toPackDto);
  }
  detail(packId: string): PackDto | null {
    const pack = this.packs.find(packId);
    return pack ? toPackDto(pack) : null;
  }

  /** 内部入口：种子不离开服务端，审计记录含规则版本、种子哈希和结果摘要，可离线重放。 */
  generateAuditedResult(
    packId: string,
    now = new Date().toISOString()
  ): PackRuleReplayResult | "not-found" | "disabled" {
    return withinTransaction(this.database, () =>
      this.generateAuditedResultInTransaction(packId, now)
    );
  }

  /** 商店仅展示可结算的活动包；概率公示仍由 list/detail 提供全部配置。 */
  shopList(): PackDto[] {
    return this.packs
      .list()
      .filter((pack) => pack.enabled === 1 && this.packs.hasAllCandidateSkus(pack.definition))
      .map(toPackDto);
  }

  purchasePreview(
    userId: string,
    packId: string
  ): PackPurchasePreviewDto | "not-found" | "disabled" | "invalid" {
    const pack = this.packs.find(packId);
    if (!pack) return "not-found";
    if (pack.enabled !== 1) return "disabled";
    if (!this.packs.hasAllCandidateSkus(pack.definition)) return "invalid";
    const balance = this.users.balance(userId);
    return {
      pack: toPackDto(pack),
      ruleVersion: pack.active_rule_version,
      cost: { amount: pack.price_amount, currency: "GAME_CREDIT" },
      canPurchase: balance !== null && balance.available.amount >= pack.price_amount,
      unavailableReason:
        balance === null
          ? "archive_required"
          : balance.available.amount < pack.price_amount
            ? "insufficient_balance"
            : null
    };
  }

  openingHistory(userId: string, cursor: string | undefined, limit: number): Page<PackOpeningDto> {
    const offset = cursor ? Number.parseInt(cursor, 10) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("开包记录分页游标无效");
    const rows = this.database
      .prepare(
        "SELECT result_summary_json FROM pack_openings WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?"
      )
      .all(userId, limit + 1, offset) as Array<{ result_summary_json: string }>;
    const hasMore = rows.length > limit;
    return {
      items: rows
        .slice(0, limit)
        .map((row) => JSON.parse(row.result_summary_json) as PackOpeningDto),
      page: { hasMore, nextCursor: hasMore ? String(offset + limit) : null }
    };
  }

  /**
   * I12B 唯一的开包命令。随机审计、扣款账本、库存入账、开包记录、事实事件、审计和幂等响应
   * 都在 InventoryService 的同一个 SQLite 短事务中提交；任一写入失败都会回滚全部结果。
   */
  openForPurchase(input: {
    userId: string;
    packId: string;
    ruleVersion: string;
    idempotencyKey: string;
    requestFingerprint: string;
    requestId: string;
    now?: Date;
  }): PackOpeningCommandResult {
    const now = (input.now ?? new Date()).toISOString();
    return this.inventory.withLedgerTransaction(() => {
      const existing = this.findIdempotency(input.userId, input.idempotencyKey);
      if (existing) return this.idempotencyResult(existing, input.requestFingerprint);
      try {
        this.database
          .prepare(
            "INSERT INTO idempotency_requests (id, actor_id, idempotency_key, request_fingerprint, status, response_status, response_json, created_at, completed_at) VALUES (?, ?, ?, ?, 'running', NULL, NULL, ?, NULL)"
          )
          .run(randomUUID(), input.userId, input.idempotencyKey, input.requestFingerprint, now);
      } catch {
        const raced = this.findIdempotency(input.userId, input.idempotencyKey);
        return raced
          ? this.idempotencyResult(raced, input.requestFingerprint)
          : { state: "in-progress" };
      }

      const pack = this.packs.find(input.packId);
      if (!pack) return this.completeFailure(input, now, 404, "RESOURCE_NOT_FOUND", "补充包不存在");
      if (pack.enabled !== 1)
        return this.completeFailure(input, now, 409, "RESOURCE_CONFLICT", "补充包当前已下架");
      if (pack.active_rule_version !== input.ruleVersion)
        return this.completeFailure(
          input,
          now,
          409,
          "VERSION_STALE",
          "补充包规则版本已更新，请重新确认购买"
        );
      if (!this.packs.hasAllCandidateSkus(pack.definition))
        return this.completeFailure(
          input,
          now,
          409,
          "RULE_VIOLATION",
          "补充包配置包含无效卡牌，暂时无法购买"
        );
      if (!this.users.balance(input.userId))
        return this.completeFailure(input, now, 409, "RESOURCE_CONFLICT", "请先创建游戏存档");
      if (
        this.users.spendAvailableFunds(
          input.userId,
          pack.price_amount,
          now,
          `pack-open:${input.idempotencyKey}`
        ) === "insufficient"
      ) {
        return this.completeFailure(
          input,
          now,
          409,
          "INSUFFICIENT_BALANCE",
          "可用余额不足，无法购买补充包"
        );
      }

      const generated = this.generateAuditedResultInTransaction(pack.id, now);
      if (typeof generated === "string") throw new Error("补充包在交易中意外变为不可用");
      const openingId = randomUUID();
      const received = summarizeReceived(generated.result, pack.price_amount);
      for (const card of received) {
        const unitCosts = allocateUnitCosts(card.cost.amount, card.quantity);
        for (const unitCostAmount of unitCosts) {
          const holding = this.inventory.acquireInLedgerTransaction({
            userId: input.userId,
            skuId: card.skuId,
            quantityDelta: 1,
            unitCostAmount,
            reason: "pack_opened",
            correlationId: openingId,
            now
          });
          if (holding === "insufficient") throw new Error("开包入库失败");
        }
      }
      const opening = toOpeningDto(
        openingId,
        pack.id,
        generated.result.ruleVersion,
        pack.price_amount,
        received,
        now
      );
      this.packs.createOpening({
        id: openingId,
        userId: input.userId,
        packId: pack.id,
        replayId: generated.replayId,
        ruleVersion: generated.result.ruleVersion,
        spentAmount: pack.price_amount,
        resultSummary: opening,
        now
      });
      const eventId = randomUUID();
      const event = {
        id: eventId,
        type: "pack.opened" as const,
        version: 1 as const,
        occurredAt: now,
        correlationId: openingId,
        payload: {
          userId: input.userId,
          packId: pack.id,
          packRuleVersion: generated.result.ruleVersion,
          spent: { amount: pack.price_amount, currency: "GAME_CREDIT" as const },
          received: received.map((card) => ({ skuId: card.skuId, quantity: card.quantity }))
        }
      };
      this.database
        .prepare(
          "INSERT INTO fact_events (id, event_type, aggregate_type, aggregate_id, version, payload_json, occurred_at) VALUES (?, 'pack.opened', 'pack_opening', ?, 1, ?, ?)"
        )
        .run(eventId, openingId, JSON.stringify(event), now);
      this.database
        .prepare(
          "INSERT INTO outbox (id, event_id, destination, payload_json, status, created_at, dispatched_at) VALUES (?, ?, 'market.fact-event', ?, 'pending', ?, NULL)"
        )
        .run(randomUUID(), eventId, JSON.stringify(event), now);
      this.users.writeEconomicAudit(
        input.userId,
        "pack.opened",
        "pack_opening",
        openingId,
        input.requestId,
        {
          packId: pack.id,
          packRuleVersion: generated.result.ruleVersion,
          spentAmount: pack.price_amount,
          received: event.payload.received
        },
        now
      );
      const response = success(input.requestId, { opening });
      this.completeIdempotency(input.userId, input.idempotencyKey, 201, response, now);
      return { state: "completed", statusCode: 201, response };
    });
  }

  private generateAuditedResultInTransaction(
    packId: string,
    now: string
  ): PackRuleReplayResult | "not-found" | "disabled" {
    const pack = this.packs.find(packId);
    if (!pack) return "not-found";
    if (pack.enabled !== 1) return "disabled";
    const randomSeed = this.createSeed();
    if (!/^[a-f0-9]{64}$/i.test(randomSeed)) throw new Error("CSPRNG 返回了无效随机种子");
    const result = openPack({ ...pack.definition, randomSeed });
    const randomSeedHash = createHash("sha256").update(randomSeed).digest("hex");
    const replayId = this.packs.recordRuleReplay({
      packId: pack.id,
      packRuleId: pack.pack_rule_id,
      randomSeed,
      randomSeedHash,
      resultSummary: result,
      now
    });
    return { replayId, randomSeedHash, result };
  }

  private findIdempotency(actorId: string, key: string): IdempotencyRow | undefined {
    return this.database
      .prepare(
        "SELECT request_fingerprint, status, response_status, response_json FROM idempotency_requests WHERE actor_id = ? AND idempotency_key = ?"
      )
      .get(actorId, key) as IdempotencyRow | undefined;
  }

  private idempotencyResult(
    existing: IdempotencyRow,
    fingerprint: string
  ): PackOpeningCommandResult {
    if (existing.request_fingerprint !== fingerprint) return { state: "conflict" };
    if (existing.status !== "completed" || !existing.response_json || !existing.response_status)
      return { state: "in-progress" };
    return {
      state: "replayed",
      statusCode: existing.response_status,
      response: JSON.parse(existing.response_json) as ApiResponse<{ opening: PackOpeningDto }>
    };
  }

  private completeFailure(
    input: { userId: string; idempotencyKey: string; requestId: string },
    now: string,
    statusCode: number,
    code:
      | "RESOURCE_NOT_FOUND"
      | "RESOURCE_CONFLICT"
      | "VERSION_STALE"
      | "INSUFFICIENT_BALANCE"
      | "RULE_VIOLATION",
    message: string
  ): PackOpeningCommandResult {
    const response = failure(input.requestId, code, message);
    this.completeIdempotency(input.userId, input.idempotencyKey, statusCode, response, now);
    return { state: "completed", statusCode, response };
  }

  private completeIdempotency(
    actorId: string,
    key: string,
    statusCode: number,
    response: ApiResponse<{ opening: PackOpeningDto }>,
    now: string
  ): void {
    const changed = this.database
      .prepare(
        "UPDATE idempotency_requests SET status = 'completed', response_status = ?, response_json = ?, completed_at = ? WHERE actor_id = ? AND idempotency_key = ? AND status = 'running'"
      )
      .run(statusCode, JSON.stringify(response), now, actorId, key);
    if (changed.changes !== 1) throw new Error("开包幂等请求状态损坏");
  }
}

function allocateUnitCosts(total: number, quantity: number): number[] {
  const base = Math.floor(total / quantity);
  const remainder = total % quantity;
  return Array.from({ length: quantity }, (_, index) => base + (index < remainder ? 1 : 0));
}

function summarizeReceived(result: PackOpenResult, spentAmount: number): PackOpeningCardDto[] {
  const costs = allocateUnitCosts(spentAmount, result.cards.length);
  const bySku = new Map<string, { quantity: number; cost: number }>();
  result.cards.forEach((card, index) => {
    const current = bySku.get(card.skuId) ?? { quantity: 0, cost: 0 };
    current.quantity += 1;
    current.cost += costs[index]!;
    bySku.set(card.skuId, current);
  });
  return [...bySku.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([skuId, value]) => ({
      skuId,
      quantity: value.quantity,
      cost: { amount: value.cost, currency: "GAME_CREDIT" },
      referencePrice: null,
      gamePrice: null,
      priceStatus: "unavailable_until_i17"
    }));
}

function toOpeningDto(
  id: string,
  packId: string,
  packRuleVersion: string,
  spentAmount: number,
  received: PackOpeningCardDto[],
  openedAt: string
): PackOpeningDto {
  const spent = { amount: spentAmount, currency: "GAME_CREDIT" as const };
  return {
    id,
    packId,
    packRuleVersion,
    spent,
    received,
    profitLoss: {
      spent,
      referenceValue: null,
      gameValue: null,
      referenceProfitLoss: null,
      gameProfitLoss: null,
      priceStatus: "unavailable_until_i17"
    },
    openedAt
  };
}

export function packOpenRequestFingerprint(body: unknown): string {
  return createHash("sha256").update(canonicalizeRequest(body)).digest("hex");
}
