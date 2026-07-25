import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { openPack, packSlotProbabilities, type PackOpenResult } from "@mtg-market/rules";
import type { PackDto } from "@mtg-market/contracts";
import { withinTransaction } from "@mtg-market/database";
import { SqlitePackRepository, type StoredPackConfiguration } from "../infrastructure/sqlite-pack-repository.js";

function toPackDto(pack: StoredPackConfiguration): PackDto {
  return {
    id: pack.id, code: pack.code, name: pack.name, description: pack.description,
    price: { amount: pack.price_amount, currency: "GAME_CREDIT" }, enabled: pack.enabled === 1,
    disabledReason: pack.disabled_reason, ruleVersion: pack.active_rule_version,
    slots: packSlotProbabilities(pack.definition).map((slot) => ({ id: slot.slotId, draws: slot.draws, rarityProbabilities: slot.rarityProbabilities })),
    updatedAt: pack.updated_at
  };
}

export type PackRuleReplayResult = { replayId: string; randomSeedHash: string; result: PackOpenResult };

/**
 * I11B 只提供配置读取与随机审计。I12B 会在同一经济短事务中调用此规则并追加扣款、
 * 库存、事实事件及幂等结果；这里没有对浏览器开放开奖命令。
 */
export class PackService {
  private readonly packs: SqlitePackRepository;
  constructor(private readonly database: Database.Database, private readonly createSeed: () => string = () => randomBytes(32).toString("hex")) {
    this.packs = new SqlitePackRepository(database);
  }

  list(): PackDto[] { return this.packs.list().map(toPackDto); }
  detail(packId: string): PackDto | null { const pack = this.packs.find(packId); return pack ? toPackDto(pack) : null; }

  /** 内部入口：种子不离开服务端，审计记录含规则版本、种子哈希和结果摘要，可离线重放。 */
  generateAuditedResult(packId: string, now = new Date().toISOString()): PackRuleReplayResult | "not-found" | "disabled" {
    return withinTransaction(this.database, () => {
      const pack = this.packs.find(packId);
      if (!pack) return "not-found";
      if (pack.enabled !== 1) return "disabled";
      const randomSeed = this.createSeed();
      if (!/^[a-f0-9]{64}$/i.test(randomSeed)) throw new Error("CSPRNG 返回了无效随机种子");
      const result = openPack({ ...pack.definition, randomSeed });
      const randomSeedHash = createHash("sha256").update(randomSeed).digest("hex");
      const replayId = this.packs.recordRuleReplay({ packId: pack.id, packRuleId: pack.pack_rule_id, randomSeed, randomSeedHash, resultSummary: result, now });
      return { replayId, randomSeedHash, result };
    });
  }
}
