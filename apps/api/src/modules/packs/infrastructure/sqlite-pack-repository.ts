import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { PackRuleInput } from "@mtg-market/rules";

export type PackConfigurationRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  price_amount: number;
  enabled: number;
  disabled_reason: string | null;
  active_rule_version: string;
  updated_at: string;
  pack_rule_id: string;
  definition_json: string;
};

export type StoredPackConfiguration = Omit<PackConfigurationRow, "definition_json"> & {
  definition: PackRuleInput;
};

function decodeDefinition(row: PackConfigurationRow): StoredPackConfiguration {
  let definition: PackRuleInput;
  try {
    definition = JSON.parse(row.definition_json) as PackRuleInput;
  } catch {
    throw new Error(`补充包 ${row.id} 的规则定义不是 JSON`);
  }
  if (
    !definition ||
    typeof definition !== "object" ||
    definition.version !== row.active_rule_version
  ) {
    throw new Error(`补充包 ${row.id} 的活动规则版本不匹配`);
  }
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    price_amount: row.price_amount,
    enabled: row.enabled,
    disabled_reason: row.disabled_reason,
    active_rule_version: row.active_rule_version,
    updated_at: row.updated_at,
    pack_rule_id: row.pack_rule_id,
    definition
  };
}

/** 补充包 SQLite 适配器只读配置、追加随机审计；配置写接口留给 I30B 管理模块。 */
export class SqlitePackRepository {
  constructor(private readonly database: Database.Database) {}

  list(): StoredPackConfiguration[] {
    const rows = this.database
      .prepare(`${this.selectConfigurationSql()} ORDER BY p.name COLLATE NOCASE, p.id`)
      .all() as PackConfigurationRow[];
    return rows.map(decodeDefinition);
  }

  find(packId: string): StoredPackConfiguration | null {
    const row = this.database
      .prepare(`${this.selectConfigurationSql()} WHERE p.id = ?`)
      .get(packId) as PackConfigurationRow | undefined;
    return row ? decodeDefinition(row) : null;
  }

  createOpening(input: {
    id: string;
    userId: string;
    packId: string;
    replayId: string;
    ruleVersion: string;
    spentAmount: number;
    resultSummary: unknown;
    now: string;
  }): void {
    this.database
      .prepare(
        "INSERT INTO pack_openings (id, user_id, pack_id, pack_rule_replay_id, pack_rule_version, spent_amount, result_summary_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        input.id,
        input.userId,
        input.packId,
        input.replayId,
        input.ruleVersion,
        input.spentAmount,
        JSON.stringify(input.resultSummary),
        input.now
      );
  }

  /** 开包前验证规则快照引用的 SKU 仍存在，避免失效目录配置进入经济结算。 */
  hasAllCandidateSkus(definition: PackRuleInput): boolean {
    const skuIds = [
      ...new Set(
        definition.pools.flatMap((pool) => pool.candidates.map((candidate) => candidate.skuId))
      )
    ];
    if (skuIds.length === 0) return false;
    const placeholders = skuIds.map(() => "?").join(", ");
    const row = this.database
      .prepare(`SELECT COUNT(*) AS count FROM card_skus WHERE id IN (${placeholders})`)
      .get(...skuIds) as { count: number };
    return row.count === skuIds.length;
  }

  recordRuleReplay(input: {
    packId: string;
    packRuleId: string;
    randomSeed: string;
    randomSeedHash: string;
    resultSummary: unknown;
    now: string;
  }): string {
    const id = randomUUID();
    this.database
      .prepare(
        "INSERT INTO pack_rule_replays (id, pack_id, pack_rule_id, random_seed, random_seed_hash, result_summary_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        id,
        input.packId,
        input.packRuleId,
        input.randomSeed,
        input.randomSeedHash,
        JSON.stringify(input.resultSummary),
        input.now
      );
    return id;
  }

  /**
   * I30B 管理员发布新版本补充包规则。规则以 `(pack_id, version)` 不可变快照追加；
   * 发布后切换 booster_packs.active_rule_version，绝不原地覆盖已发布版本。调用方须处于事务内。
   * 同版本重复发布由 UNIQUE(pack_id, version) 拦截，返回 false。
   */
  publishRule(packId: string, definition: PackRuleInput, now: string): boolean {
    const ruleId = randomUUID();
    const insertResult = this.database
      .prepare(
        "INSERT OR IGNORE INTO booster_pack_rules (id, pack_id, version, definition_json, created_at, retired_at) VALUES (?, ?, ?, ?, ?, NULL)"
      )
      .run(ruleId, packId, definition.version, JSON.stringify(definition), now);
    if (insertResult.changes !== 1) return false;
    const updateResult = this.database
      .prepare("UPDATE booster_packs SET active_rule_version = ?, updated_at = ? WHERE id = ?")
      .run(definition.version, now, packId);
    return updateResult.changes === 1;
  }

  /** I30B 停用补充包；保留审计，不删除已发布规则。调用方须处于事务内。 */
  disablePack(packId: string, reason: string, now: string): boolean {
    const result = this.database
      .prepare("UPDATE booster_packs SET enabled = 0, disabled_reason = ?, updated_at = ? WHERE id = ? AND enabled = 1")
      .run(reason, now, packId);
    return result.changes === 1;
  }

  /** I30B 启用补充包；清空停用原因，保留审计。调用方须处于事务内。 */
  enablePack(packId: string, now: string): boolean {
    const result = this.database
      .prepare("UPDATE booster_packs SET enabled = 1, disabled_reason = NULL, updated_at = ? WHERE id = ? AND enabled = 0")
      .run(now, packId);
    return result.changes === 1;
  }

  private selectConfigurationSql(): string {
    return `SELECT p.id, p.code, p.name, p.description, p.price_amount, p.enabled, p.disabled_reason,
      p.active_rule_version, p.updated_at, rule.id AS pack_rule_id, rule.definition_json
      FROM booster_packs p
      JOIN booster_pack_rules rule ON rule.pack_id = p.id AND rule.version = p.active_rule_version`;
  }
}
