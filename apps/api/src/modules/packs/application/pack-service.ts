import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { openPack, packSlotProbabilities, type PackOpenResult, type PackRuleInput } from "@mtg-market/rules";
import {
  canonicalizeRequest,
  type ApiResponse,
  type BulkPackOpeningDto,
  type BulkPackOpeningSummaryDto,
  type PackDto,
  type PackOfferDto,
  type PackOpeningCardDto,
  type PackOpeningDto,
  type PackPurchasePreviewDto,
  type Page
} from "@mtg-market/contracts";
import { withinTransaction } from "@mtg-market/database";
import {
  SqlitePackRepository,
  type StoredPackConfiguration,
  type StoredPackOffer
} from "../infrastructure/sqlite-pack-repository.js";
import { InventoryService } from "../../inventory/application/inventory-service.js";
import { UserService } from "../../users/application/user-service.js";
import { MarketService } from "../../market/application/market-service.js";
import { enqueueMarketRepriceJob, enqueuePackAchievementProcessJob } from "../../jobs/application/task-service.js";
import { failure, success } from "../../../shared/http/api-response.js";

function toPackOfferDto(offer: StoredPackOffer | null, now: string): PackOfferDto | null {
  if (!offer) return null;
  const status = offer.status === "ended" ? "ended" : now < offer.starts_at ? "scheduled" : now >= offer.ends_at ? "ended" : "active";
  return {
    id: offer.id,
    packId: offer.pack_id,
    name: offer.name,
    description: offer.description,
    discountBps: offer.discount_bps,
    startsAt: offer.starts_at,
    endsAt: offer.ends_at,
    status,
    version: offer.version,
    updatedAt: offer.updated_at
  };
}

/** 窗口内实际售价 = price × discountBps ÷ 10_000，整数向下取整；无生效窗口返回原价。 */
function effectivePriceAmount(pack: StoredPackConfiguration, offer: PackOfferDto | null): number {
  if (!offer || offer.status !== "active") return pack.price_amount;
  return Math.floor((pack.price_amount * offer.discountBps) / 10_000);
}

function toPackDto(pack: StoredPackConfiguration, offer: PackOfferDto | null): PackDto {
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
    offer,
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

/** I33B（C7）批量开包命令结果；幂等与冲突语义与单包一致。 */
export type PackBulkCommandResult =
  | { state: "completed"; statusCode: number; response: ApiResponse<{ bulk: BulkPackOpeningDto }> }
  | { state: "replayed"; statusCode: number; response: ApiResponse<{ bulk: BulkPackOpeningDto }> }
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
  private readonly market: MarketService;
  constructor(
    private readonly database: Database.Database,
    private readonly createSeed: () => string = () => randomBytes(32).toString("hex")
  ) {
    this.packs = new SqlitePackRepository(database);
    this.inventory = new InventoryService(database);
    this.users = new UserService(database);
    this.market = new MarketService(database);
  }

  list(now = new Date().toISOString()): PackDto[] {
    return this.packs.list().map((pack) => toPackDto(pack, toPackOfferDto(this.packs.findOffer(pack.id), now)));
  }
  detail(packId: string, now = new Date().toISOString()): PackDto | null {
    const pack = this.packs.find(packId);
    return pack ? toPackDto(pack, toPackOfferDto(this.packs.findOffer(pack.id), now)) : null;
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

  /**
   * I30B 管理员发布新版本补充包规则。规则经服务端候选池/卡位/权重/工艺校验后，
   * 以 `(pack_id, version)` 不可变快照追加并切换 active_rule_version；已发布版本不可原地覆盖。
   * 返回新规则版本号；pack 不存在返回 "not-found"，版本已存在返回 "version-conflict"。
   */
  publishRule(packId: string, definition: PackRuleInput, now: string): string | "not-found" | "version-conflict" {
    const pack = this.packs.find(packId);
    if (!pack) return "not-found";
    // packSlotProbabilities 内部调用 validatePackRule，校验候选池/卡位/权重/工艺边界。
    packSlotProbabilities(definition);
    return withinTransaction(this.database, () => {
      const published = this.packs.publishRule(packId, definition, now);
      return published ? definition.version : "version-conflict";
    });
  }

  /** I30B 管理员停用补充包；保留审计，不删除已发布规则。 */
  disablePack(packId: string, reason: string, now: string): boolean {
    return withinTransaction(this.database, () => this.packs.disablePack(packId, reason, now));
  }

  /** I30B 管理员启用补充包；清空停用原因。 */
  enablePack(packId: string, now: string): boolean {
    return withinTransaction(this.database, () => this.packs.enablePack(packId, now));
  }

  /** I30B 管理员发布前预览：返回服务端计算的稀有度概率与候选池校验结果。 */
  previewRule(packId: string, definition: PackRuleInput): { valid: boolean; slots: Array<{ id: string; draws: number; rarityProbabilities: Array<{ rarity: string; probabilityBasisPoints: number }> }>; candidatePoolSize: number; issues: string[] } | "not-found" {
    const pack = this.packs.find(packId);
    if (!pack) return "not-found";
    const issues: string[] = [];
    let slots: Array<{ id: string; draws: number; rarityProbabilities: Array<{ rarity: string; probabilityBasisPoints: number }> }> = [];
    try {
      slots = packSlotProbabilities(definition).map((slot) => ({ id: slot.slotId, draws: slot.draws, rarityProbabilities: slot.rarityProbabilities }));
    } catch (error) {
      issues.push(error instanceof Error ? error.message : "规则校验失败");
    }
    const candidatePoolSize = this.packs.hasAllCandidateSkus(definition) ? new Set(definition.pools.flatMap((pool) => pool.candidates.map((candidate) => candidate.skuId))).size : 0;
    if (!this.packs.hasAllCandidateSkus(definition)) issues.push("候选池存在未建档 SKU");
    return { valid: issues.length === 0, slots, candidatePoolSize, issues };
  }

  /** 商店仅展示可结算的活动包；概率公示仍由 list/detail 提供全部配置。 */
  shopList(now = new Date().toISOString()): PackDto[] {
    return this.packs
      .list()
      .filter((pack) => pack.enabled === 1 && this.packs.hasAllCandidateSkus(pack.definition))
      .map((pack) => toPackDto(pack, toPackOfferDto(this.packs.findOffer(pack.id), now)));
  }

  purchasePreview(
    userId: string,
    packId: string,
    now = new Date().toISOString()
  ): PackPurchasePreviewDto | "not-found" | "disabled" | "invalid" | "offer-not-active" {
    const pack = this.packs.find(packId);
    if (!pack) return "not-found";
    if (pack.enabled !== 1) return "disabled";
    if (!this.packs.hasAllCandidateSkus(pack.definition)) return "invalid";
    const offer = toPackOfferDto(this.packs.findOffer(pack.id), now);
    // 有 offer 的包只在销售窗口内可购买；未开始/已结束与下架同语义拒绝。
    if (offer !== null && offer.status !== "active") return "offer-not-active";
    const priceAmount = effectivePriceAmount(pack, offer);
    const balance = this.users.balance(userId);
    return {
      pack: toPackDto(pack, offer),
      ruleVersion: pack.active_rule_version,
      cost: { amount: priceAmount, currency: "GAME_CREDIT" },
      canPurchase: balance !== null && balance.available.amount >= priceAmount,
      unavailableReason:
        balance === null
          ? "archive_required"
          : balance.available.amount < priceAmount
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
   * I33B：DTO 增强为每张开出的卡携带新卡标记与系列完成度快照，并返回本包总成本/总价值。
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
      const offer = toPackOfferDto(this.packs.findOffer(pack.id), now);
      if (offer !== null && offer.status !== "active")
        return this.completeFailure(input, now, 409, "RESOURCE_CONFLICT", "限时补充包当前不在销售窗口内，暂时无法购买");
      const priceAmount = effectivePriceAmount(pack, offer);
      if (
        this.users.spendAvailableFunds(
          input.userId,
          priceAmount,
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

      const settled = this.settleSingleOpening({
        userId: input.userId,
        pack,
        effectivePrice: priceAmount,
        ruleVersion: input.ruleVersion,
        requestId: input.requestId,
        correlationSuffix: input.idempotencyKey,
        seenSkus: this.heldSkuIds(input.userId),
        now
      });
      const response = success(input.requestId, { opening: settled.opening });
      this.completeIdempotency(input.userId, input.idempotencyKey, 201, response, now);
      return { state: "completed", statusCode: 201, response };
    });
  }

  /**
   * I33B（C7）批量开包：10/50/100 包在同一经济短事务内逐包结算（每包独立 replay/扣款/入库/
   * 开包记录/事实事件），任一包失败整批回滚；幂等与费用约束复用单包语义。返回逐包结果与
   * 服务端汇总（各稀有度计数、总成本、总价值、新增 SKU 数）。
   */
  openBulk(input: {
    userId: string;
    packId: string;
    ruleVersion: string;
    count: number;
    idempotencyKey: string;
    requestFingerprint: string;
    requestId: string;
    now?: Date;
  }): PackBulkCommandResult {
    const now = (input.now ?? new Date()).toISOString();
    return this.inventory.withLedgerTransaction(() => {
      const existing = this.findIdempotency(input.userId, input.idempotencyKey);
      if (existing) return this.bulkIdempotencyResult(existing, input.requestFingerprint);
      try {
        this.database
          .prepare(
            "INSERT INTO idempotency_requests (id, actor_id, idempotency_key, request_fingerprint, status, response_status, response_json, created_at, completed_at) VALUES (?, ?, ?, ?, 'running', NULL, NULL, ?, NULL)"
          )
          .run(randomUUID(), input.userId, input.idempotencyKey, input.requestFingerprint, now);
      } catch {
        const raced = this.findIdempotency(input.userId, input.idempotencyKey);
        return raced
          ? this.bulkIdempotencyResult(raced, input.requestFingerprint)
          : { state: "in-progress" };
      }

      const pack = this.packs.find(input.packId);
      if (!pack) return this.completeBulkFailure(input, now, 404, "RESOURCE_NOT_FOUND", "补充包不存在");
      if (pack.enabled !== 1)
        return this.completeBulkFailure(input, now, 409, "RESOURCE_CONFLICT", "补充包当前已下架");
      if (pack.active_rule_version !== input.ruleVersion)
        return this.completeBulkFailure(input, now, 409, "VERSION_STALE", "补充包规则版本已更新，请重新确认购买");
      if (!this.packs.hasAllCandidateSkus(pack.definition))
        return this.completeBulkFailure(input, now, 409, "RULE_VIOLATION", "补充包配置包含无效卡牌，暂时无法购买");
      if (!this.users.balance(input.userId))
        return this.completeBulkFailure(input, now, 409, "RESOURCE_CONFLICT", "请先创建游戏存档");
      const offer = toPackOfferDto(this.packs.findOffer(pack.id), now);
      if (offer !== null && offer.status !== "active")
        return this.completeBulkFailure(input, now, 409, "RESOURCE_CONFLICT", "限时补充包当前不在销售窗口内，暂时无法购买");
      const priceAmount = effectivePriceAmount(pack, offer);
      const balance = this.users.balance(input.userId)!;
      if (balance.available.amount < priceAmount * input.count) {
        return this.completeBulkFailure(input, now, 409, "INSUFFICIENT_BALANCE", "可用余额不足，无法批量购买补充包");
      }

      // 批量作为一个整体结算单位：开包前已持有的 SKU 集合决定首包新卡标记，后续包内重复卡不再计为新卡。
      const seenSkus = this.heldSkuIds(input.userId);
      const openings: PackOpeningDto[] = [];
      const rarityCounts = new Map<string, number>();
      const newSkuIds = new Set<string>();
      let totalGameValue: number | null = 0;
      for (let index = 0; index < input.count; index += 1) {
        const correlationSuffix = `${input.idempotencyKey}:${index}`;
        if (this.users.spendAvailableFunds(input.userId, priceAmount, now, `pack-open:${correlationSuffix}`) === "insufficient") {
          throw new Error("批量开包扣款失败，事务回滚");
        }
        const settled = this.settleSingleOpening({
          userId: input.userId,
          pack,
          effectivePrice: priceAmount,
          ruleVersion: input.ruleVersion,
          requestId: input.requestId,
          correlationSuffix,
          seenSkus,
          now
        });
        openings.push(settled.opening);
        for (const [rarity, quantity] of settled.rarityCounts) rarityCounts.set(rarity, (rarityCounts.get(rarity) ?? 0) + quantity);
        for (const skuId of settled.newSkuIds) newSkuIds.add(skuId);
        if (settled.opening.totalGameValue === null) totalGameValue = null;
        else if (totalGameValue !== null) totalGameValue += settled.opening.totalGameValue.amount;
      }
      const summary: BulkPackOpeningSummaryDto = {
        packId: pack.id,
        packRuleVersion: pack.active_rule_version,
        count: input.count,
        rarityCounts: [...rarityCounts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([rarity, quantity]) => ({ rarity, quantity })),
        totalCost: { amount: priceAmount * input.count, currency: "GAME_CREDIT" },
        totalGameValue: totalGameValue === null ? null : { amount: totalGameValue, currency: "GAME_CREDIT" },
        newSkuCount: newSkuIds.size
      };
      const bulk: BulkPackOpeningDto = { summary, openings };
      const response = success(input.requestId, { bulk });
      this.completeIdempotency(input.userId, input.idempotencyKey, 201, response, now);
      return { state: "completed", statusCode: 201, response };
    });
  }

  /**
   * 受控奖励的无扣费开包协作入口。调用方必须已在自己的经济短事务内验证并消费
   * 不可重放的奖励凭证；本方法只执行 Pack 模块拥有的随机审计、入库、事实和审计。
   */
  openTournamentGrantInLedgerTransaction(input: {
    userId: string;
    packId: string;
    grantId: string;
    requestId: string;
    now: string;
  }): PackOpeningDto {
    const pack = this.packs.find(input.packId);
    if (!pack) throw new Error("奖励补充包不存在");
    if (!this.packs.hasAllCandidateSkus(pack.definition)) throw new Error("奖励补充包配置已失效");
    // 凭证在发奖时只允许选择在售包；后续下架不会取消既有奖励，仍以已发布规则开包。
    return this.settleSingleOpening({
      userId: input.userId,
      pack,
      effectivePrice: 0,
      ruleVersion: pack.active_rule_version,
      requestId: input.requestId,
      correlationSuffix: input.grantId,
      seenSkus: this.heldSkuIds(input.userId),
      now: input.now,
      allowDisabled: true,
      grantSource: "tournament_reward"
    }).opening;
  }

  /** I33B（C6）：管理员配置限时/折扣销售窗口；同一包已有活动窗口时返回 "offer-conflict"。 */
  createOffer(input: { packId: string; name: string; description: string | null; discountBps: number; startsAt: string; endsAt: string; actorId: string | null; now: string }): { offer: PackOfferDto } | "not-found" | "offer-conflict" {
    const pack = this.packs.find(input.packId);
    if (!pack) return "not-found";
    return withinTransaction(this.database, () => {
      const offerId = randomUUID();
      const created = this.packs.createOffer({ id: offerId, packId: input.packId, name: input.name, description: input.description, discountBps: input.discountBps, startsAt: input.startsAt, endsAt: input.endsAt, createdBy: input.actorId, now: input.now });
      if (!created) return "offer-conflict";
      return { offer: toPackOfferDto(this.packs.findOffer(input.packId), input.now)! };
    });
  }

  /** I33B（C6）：管理员提前结束限时销售窗口；找不到或已结束返回 false。 */
  endOffer(offerId: string, now: string): boolean {
    return withinTransaction(this.database, () => this.packs.endOffer(offerId, now));
  }

  /** I33B（C6）：到期窗口批量标记 ended；由每日任务调用，返回本次结束的窗口数。 */
  expireOffers(now = new Date().toISOString()): number {
    return this.packs.expireOffers(now);
  }

  /**
   * I33B（C6）：服务端计算每个补充包当前销售窗口与有效价格；供管理端与任务展示，
   * 不写经济表。无 offer 的包返回 null。
   */
  offerOf(packId: string, now = new Date().toISOString()): PackOfferDto | null {
    const pack = this.packs.find(packId);
    if (!pack) return null;
    return toPackOfferDto(this.packs.findOffer(packId), now);
  }

  /** 玩家开包前已持有（quantity > 0）的 SKU 集合；作为"本次结算前是否已收集"的依据。 */
  heldSkuIds(userId: string): Set<string> {
    const rows = this.database.prepare(
      "SELECT sku_id FROM inventory_holdings WHERE user_id = ? AND quantity > 0"
    ).all(userId) as Array<{ sku_id: string }>;
    return new Set(rows.map((row) => row.sku_id));
  }

  /**
   * I33B 共享的单包结算（调用方必须已处于经济短事务内）：随机审计、入库、开包记录、
   * `pack.opened` 事实/outbox/重定价任务与审计一次完成。`seenSkus` 为批量结算单位内
   * 已见过的 SKU（含开包前持有），决定本包新卡标记；`grantSource` 非空表示奖励包。
   */
  private settleSingleOpening(input: {
    userId: string;
    pack: StoredPackConfiguration;
    effectivePrice: number;
    ruleVersion: string;
    requestId: string;
    correlationSuffix: string;
    seenSkus: Set<string>;
    now: string;
    allowDisabled?: boolean;
    grantSource?: "tournament_reward";
  }): { opening: PackOpeningDto; newSkuIds: string[]; rarityCounts: Map<string, number> } {
    const generated = this.generateAuditedResultInTransaction(input.pack.id, input.now, input.allowDisabled ?? false);
    if (typeof generated === "string") throw new Error("补充包在交易中意外变为不可用");
    const openingId = randomUUID();
    const costs = allocateUnitCosts(input.effectivePrice, generated.result.cards.length);
    const bySku = new Map<string, { quantity: number; cost: number }>();
    const rarityCounts = new Map<string, number>();
    generated.result.cards.forEach((card, index) => {
      const current = bySku.get(card.skuId) ?? { quantity: 0, cost: 0 };
      current.quantity += 1;
      current.cost += costs[index]!;
      bySku.set(card.skuId, current);
      rarityCounts.set(card.rarity, (rarityCounts.get(card.rarity) ?? 0) + 1);
    });
    const skuIds = [...bySku.keys()];
    const setCodes = this.skuSetCodes(skuIds);
    const seen = input.seenSkus;
    const newSkuIds: string[] = [];
    const received: PackOpeningCardDto[] = [];
    for (const skuId of skuIds) {
      const value = bySku.get(skuId)!;
      const quote = this.market.quote(skuId);
      const isNewToCollection = !seen.has(skuId);
      if (isNewToCollection) {
        seen.add(skuId);
        newSkuIds.push(skuId);
      }
      // 先入库，再按入库后持有投影计算该 SKU 所在系列的完成度快照。
      const unitCosts = allocateUnitCosts(value.cost, value.quantity);
      for (const unitCostAmount of unitCosts) {
        const holding = this.inventory.acquireInLedgerTransaction({
          userId: input.userId,
          skuId,
          quantityDelta: 1,
          unitCostAmount,
          reason: input.grantSource === "tournament_reward" ? "tournament_reward" : "pack_opened",
          correlationId: openingId,
          now: input.now
        });
        if (holding === "insufficient") throw new Error("开包入库失败");
      }
      const setCode = setCodes.get(skuId);
      // setCompletionStats 总是为传入的系列写入一行；setCode 存在时结果必然非空。
      const stats = setCode === undefined ? undefined : this.setCompletionStats(input.userId, [setCode]).get(setCode);
      const collectionProgressAfter = stats === undefined || setCode === undefined
        ? { setCode: setCode ?? "", collectedSkuCount: 0, totalSkuCount: 0, completionBasisPoints: 0 }
        : { setCode, collectedSkuCount: stats.collectedSkuCount, totalSkuCount: stats.totalSkuCount, completionBasisPoints: stats.completionBasisPoints };
      received.push({
        skuId,
        quantity: value.quantity,
        cost: { amount: value.cost, currency: "GAME_CREDIT" },
        referencePrice: quote?.referencePrice ?? null,
        gamePrice: quote?.marketPrice ?? null,
        priceStatus: quote ? "available" : "unavailable_until_i17",
        isNewToCollection,
        collectionProgressAfter
      });
    }
    received.sort((left, right) => left.skuId.localeCompare(right.skuId));
    const opening = toOpeningDto(openingId, input.pack.id, generated.result.ruleVersion, input.effectivePrice, received, input.now);
    this.packs.createOpening({
      id: openingId,
      userId: input.userId,
      packId: input.pack.id,
      replayId: generated.replayId,
      ruleVersion: generated.result.ruleVersion,
      spentAmount: input.effectivePrice,
      resultSummary: opening,
      now: input.now
    });
    const eventId = randomUUID();
    const event = {
      id: eventId,
      type: "pack.opened" as const,
      version: 1 as const,
      occurredAt: input.now,
      correlationId: openingId,
      payload: {
        userId: input.userId,
        packId: input.pack.id,
        packRuleVersion: generated.result.ruleVersion,
        spent: { amount: input.effectivePrice, currency: "GAME_CREDIT" as const },
        received: received.map((card) => ({ skuId: card.skuId, quantity: card.quantity }))
      }
    };
    this.database
      .prepare(
        "INSERT INTO fact_events (id, event_type, aggregate_type, aggregate_id, version, payload_json, occurred_at) VALUES (?, 'pack.opened', 'pack_opening', ?, 1, ?, ?)"
      )
      .run(eventId, openingId, JSON.stringify(event), input.now);
    this.database
      .prepare(
        "INSERT INTO outbox (id, event_id, destination, payload_json, status, created_at, dispatched_at) VALUES (?, ?, 'market.fact-event', ?, 'pending', ?, NULL)"
      )
      .run(randomUUID(), eventId, JSON.stringify(event), input.now);
    enqueueMarketRepriceJob(this.database, `fact-event:${eventId}`, input.now);
    // I33B：系列收集率成就以独立幂等任务消费 pack.opened fact；任务至少执行一次，唯一约束收敛至多一次解锁/发奖。
    enqueuePackAchievementProcessJob(this.database, eventId, input.now);
    this.users.writeEconomicAudit(
      input.userId,
      input.grantSource === "tournament_reward" ? "tournament_reward.pack_opened" : "pack.opened",
      "pack_opening",
      openingId,
      input.requestId,
      {
        packId: input.pack.id,
        packRuleVersion: generated.result.ruleVersion,
        spentAmount: input.effectivePrice,
        received: event.payload.received
      },
      input.now
    );
    return { opening, newSkuIds, rarityCounts };
  }

  private generateAuditedResultInTransaction(
    packId: string,
    now: string,
    allowDisabled = false
  ): PackRuleReplayResult | "not-found" | "disabled" {
    const pack = this.packs.find(packId);
    if (!pack) return "not-found";
    if (!allowDisabled && pack.enabled !== 1) return "disabled";
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

  private bulkIdempotencyResult(
    existing: IdempotencyRow,
    fingerprint: string
  ): PackBulkCommandResult {
    if (existing.request_fingerprint !== fingerprint) return { state: "conflict" };
    if (existing.status !== "completed" || !existing.response_json || !existing.response_status)
      return { state: "in-progress" };
    return {
      state: "replayed",
      statusCode: existing.response_status,
      response: JSON.parse(existing.response_json) as ApiResponse<{ bulk: BulkPackOpeningDto }>
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

  private completeBulkFailure(
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
  ): PackBulkCommandResult {
    const response = failure(input.requestId, code, message);
    this.completeIdempotency(input.userId, input.idempotencyKey, statusCode, response, now);
    return { state: "completed", statusCode, response };
  }

  private completeIdempotency(
    actorId: string,
    key: string,
    statusCode: number,
    response: ApiResponse<unknown>,
    now: string
  ): void {
    const changed = this.database
      .prepare(
        "UPDATE idempotency_requests SET status = 'completed', response_status = ?, response_json = ?, completed_at = ? WHERE actor_id = ? AND idempotency_key = ? AND status = 'running'"
      )
      .run(statusCode, JSON.stringify(response), now, actorId, key);
    if (changed.changes !== 1) throw new Error("开包幂等请求状态损坏");
  }

  /** SKU → 所属系列代码；批量查询避免逐卡 N+1。 */
  private skuSetCodes(skuIds: string[]): Map<string, string> {
    if (skuIds.length === 0) return new Map();
    const placeholders = skuIds.map(() => "?").join(", ");
    const rows = this.database.prepare(
      `SELECT sku.id AS sku_id, s.code AS set_code
       FROM card_skus sku JOIN card_printings p ON p.id = sku.printing_id JOIN card_sets s ON s.id = p.set_id
       WHERE sku.id IN (${placeholders})`
    ).all(...skuIds) as Array<{ sku_id: string; set_code: string }>;
    return new Map(rows.map((row) => [row.sku_id, row.set_code]));
  }

  /**
   * I33B：指定系列的完成度只读投影。totalSkuCount 为该系列全部印刷×工艺 SKU（目录全量）；
   * collectedSkuCount 为该玩家已持有（quantity > 0）的不同 SKU 数；完成度 bp 整数计算。
   * 同一印刷任一工艺已持有即视为已收集。不写任何经济表。
   */
  private setCompletionStats(userId: string, setCodes: string[]): Map<string, { collectedSkuCount: number; totalSkuCount: number; completionBasisPoints: number }> {
    const result = new Map<string, { collectedSkuCount: number; totalSkuCount: number; completionBasisPoints: number }>();
    for (const setCode of setCodes) {
      const totalRow = this.database.prepare(
        "SELECT COUNT(*) AS count FROM card_skus sku JOIN card_printings p ON p.id = sku.printing_id JOIN card_sets s ON s.id = p.set_id WHERE s.code = ?"
      ).get(setCode) as { count: number };
      const collectedRow = this.database.prepare(
        `SELECT COUNT(DISTINCT sku.id) AS count FROM inventory_holdings h
         JOIN card_skus sku ON sku.id = h.sku_id
         JOIN card_printings p ON p.id = sku.printing_id
         JOIN card_sets s ON s.id = p.set_id
         WHERE h.user_id = ? AND h.quantity > 0 AND s.code = ?`
      ).get(userId, setCode) as { count: number };
      const totalSkuCount = totalRow.count;
      const collectedSkuCount = collectedRow.count;
      const completionBasisPoints = totalSkuCount === 0 ? 0 : Math.min(10_000, Math.floor((collectedSkuCount * 10_000) / totalSkuCount));
      result.set(setCode, { collectedSkuCount, totalSkuCount, completionBasisPoints });
    }
    return result;
  }
}

function allocateUnitCosts(total: number, quantity: number): number[] {
  const base = Math.floor(total / quantity);
  const remainder = total % quantity;
  return Array.from({ length: quantity }, (_, index) => base + (index < remainder ? 1 : 0));
}

/**
 * I33B：将服务端投影的开包结果组装为 DTO。总成本 = spent；总价值按各卡 gamePrice × quantity
 * 累加（仅当全部结果项都有有效报价时才输出非 null），浏览器不得自行重算。
 */
function toOpeningDto(
  id: string,
  packId: string,
  packRuleVersion: string,
  spentAmount: number,
  received: PackOpeningCardDto[],
  openedAt: string
): PackOpeningDto {
  const spent = { amount: spentAmount, currency: "GAME_CREDIT" as const };
  const referenceValue = received.reduce<number | null>((sum, card) => {
    if (sum === null || card.referencePrice === null) return null;
    return sum + card.referencePrice.amount * card.quantity;
  }, 0);
  const gameValue = received.reduce<number | null>((sum, card) => {
    if (sum === null || card.gamePrice === null) return null;
    return sum + card.gamePrice.amount * card.quantity;
  }, 0);
  return {
    id,
    packId,
    packRuleVersion,
    spent,
    received,
    profitLoss: {
      spent,
      referenceValue: referenceValue === null ? null : { amount: referenceValue, currency: "EUR" },
      gameValue: gameValue === null ? null : { amount: gameValue, currency: "GAME_CREDIT" },
      referenceProfitLoss: null,
      gameProfitLoss: gameValue === null || gameValue === 0 ? null : { amount: gameValue - spentAmount, currency: "GAME_CREDIT" },
      priceStatus: received.some((card) => card.priceStatus === "available") ? "available" : "unavailable_until_i17"
    },
    totalCost: spent,
    totalGameValue: gameValue === null ? null : { amount: gameValue, currency: "GAME_CREDIT" },
    openedAt
  };
}

export function packOpenRequestFingerprint(body: unknown): string {
  return createHash("sha256").update(canonicalizeRequest(body)).digest("hex");
}
