import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { PackRuleInput } from "@mtg-market/rules";

const BASE_PACKS = [
  {
    id: "13000000-0000-4000-8000-000000000001",
    setCode: "BRO",
    unavailableReason: "等待 BRO 目录同步"
  },
  {
    id: "13000000-0000-4000-8000-000000000002",
    setCode: "SOS",
    unavailableReason: "等待 SOS 目录同步"
  }
] as const;

type CatalogCandidate = { id: string; rarity: "common" | "uncommon" | "rare" | "mythic" };

function basePackRuleVersion(setCode: string, sourceVersion: string, syncRunId: string): string {
  return `base/${setCode.toLowerCase()}/${sourceVersion}/${syncRunId}`;
}

function definition(
  setCode: string,
  sourceVersion: string,
  syncRunId: string,
  candidates: CatalogCandidate[]
): PackRuleInput | null {
  const byRarity = new Map<string, CatalogCandidate[]>();
  for (const candidate of candidates) {
    const pool = byRarity.get(candidate.rarity) ?? [];
    pool.push(candidate);
    byRarity.set(candidate.rarity, pool);
  }
  const common = byRarity.get("common") ?? [];
  const uncommon = byRarity.get("uncommon") ?? [];
  const rare = byRarity.get("rare") ?? [];
  const mythic = byRarity.get("mythic") ?? [];
  if (common.length === 0 || uncommon.length === 0 || rare.length === 0) return null;
  const pools = [
    ["common", common],
    ["uncommon", uncommon],
    ["rare", rare],
    ["mythic", mythic]
  ] as const;
  const activePools = pools
    .filter(([, entries]) => entries.length > 0)
    .map(([rarity, entries]) => ({
      id: rarity,
      rarity,
      candidates: entries.map((entry) => ({ skuId: entry.id, weight: 1 }))
    }));
  const rareWeights = [{ poolId: "rare", weight: mythic.length > 0 ? 7 : 1 }];
  if (mythic.length > 0) rareWeights.push({ poolId: "mythic", weight: 1 });
  return {
    version: basePackRuleVersion(setCode, sourceVersion, syncRunId),
    pools: activePools,
    slots: [
      { id: "common", draws: 10, poolWeights: [{ poolId: "common", weight: 1 }] },
      { id: "uncommon", draws: 3, poolWeights: [{ poolId: "uncommon", weight: 1 }] },
      { id: "rare", draws: 1, poolWeights: rareWeights }
    ]
  };
}

/** 由 catalog application 在目录替换事务内调用，保证基础包候选池与当前 Scryfall SKU 同步提交。 */
export class BasePackCatalogService {
  constructor(private readonly database: Database.Database) {}

  refreshAfterCatalogSync(sourceVersion: string, syncRunId: string, now: string): void {
    for (const pack of BASE_PACKS) {
      const candidates = this.database
        .prepare(
          `SELECT sku.id, printing.rarity
         FROM card_skus sku
         JOIN card_printings printing ON printing.id = sku.printing_id
         JOIN card_sets card_set ON card_set.id = printing.set_id
         WHERE card_set.code = ? AND sku.source = 'scryfall' AND sku.finish = 'nonfoil'
           AND printing.rarity IN ('common', 'uncommon', 'rare', 'mythic')
         ORDER BY printing.rarity, sku.id`
        )
        .all(pack.setCode) as CatalogCandidate[];
      const nextDefinition = definition(pack.setCode, sourceVersion, syncRunId, candidates);
      if (!nextDefinition) {
        this.database
          .prepare(
            "UPDATE booster_packs SET enabled = 0, disabled_reason = ?, updated_at = ? WHERE id = ?"
          )
          .run(pack.unavailableReason, now, pack.id);
        continue;
      }
      this.database
        .prepare(
          `INSERT INTO booster_pack_rules (id, pack_id, version, definition_json, created_at, retired_at)
         VALUES (?, ?, ?, ?, ?, NULL) ON CONFLICT(pack_id, version) DO NOTHING`
        )
        .run(randomUUID(), pack.id, nextDefinition.version, JSON.stringify(nextDefinition), now);
      this.database
        .prepare(
          "UPDATE booster_pack_rules SET retired_at = ? WHERE pack_id = ? AND version <> ? AND retired_at IS NULL"
        )
        .run(now, pack.id, nextDefinition.version);
      this.database
        .prepare(
          "UPDATE booster_packs SET enabled = 1, disabled_reason = NULL, active_rule_version = ?, updated_at = ? WHERE id = ?"
        )
        .run(nextDefinition.version, now, pack.id);
    }
  }
}
