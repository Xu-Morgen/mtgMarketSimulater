import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { withinTransaction } from "@mtg-market/database";
import { MtgjsonChecksumMismatchError, type MtgjsonClient, type MtgjsonPriceSource } from "../../../platform/external/mtgjson/mtgjson-client.js";

type SyncPayload = { expectedPricesChecksumSha256?: string; expectedMappingChecksumSha256?: string; allowChecksumMismatch?: boolean };
type SyncRow = { id: string; source_version: string; prices_checksum_sha256: string; mapping_checksum_sha256: string; status: "running" | "succeeded" | "failed"; checksum_verification: "verified" | "bypassed" | "not_verified"; mapped_skus: number; priced_skus: number; unpriced_skus: number; mapping_failed_skus: number; failure_code: "CHECKSUM_MISMATCH" | null; failure_reason: string | null; started_at: string; completed_at: string | null };
type CatalogSku = { id: string; scryfall_id: string; finish: "nonfoil" | "foil" | "etched" };
export type PriceSyncStatus = { latestSuccessful: SyncRow | null; current: SyncRow | null };

function cents(value: number): number { const result = Math.round((value + Number.EPSILON) * 100); if (!Number.isSafeInteger(result) || result <= 0) throw new Error("Cardmarket EUR 价格必须是正的安全欧分整数"); return result; }

/** 价格导入不会修改既有快照：只有完整校验后的本次运行才在一笔事务中追加快照并物化可交易状态。 */
export class PriceSyncService {
  constructor(private readonly database: Database.Database, private readonly client: MtgjsonClient) {}

  status(): PriceSyncStatus {
    const current = this.database.prepare("SELECT * FROM price_sync_runs ORDER BY started_at DESC, rowid DESC LIMIT 1").get() as SyncRow | undefined;
    const latest = this.database.prepare("SELECT r.* FROM price_sync_state s JOIN price_sync_runs r ON r.id = s.latest_successful_run_id WHERE s.singleton = 1").get() as SyncRow | undefined;
    return { latestSuccessful: latest ?? null, current: current ?? null };
  }

  async synchronize(payload: SyncPayload = {}): Promise<void> {
    const startedAt = new Date().toISOString(); const runId = randomUUID(); let source: MtgjsonPriceSource | null = null;
    try {
      source = await this.client.download({ allowChecksumMismatch: payload.allowChecksumMismatch === true });
      if (payload.expectedPricesChecksumSha256 && payload.expectedPricesChecksumSha256 !== source.pricesChecksumSha256) throw new Error("MTGJSON AllPricesToday checksum 不匹配");
      if (payload.expectedMappingChecksumSha256 && payload.expectedMappingChecksumSha256 !== source.mappingChecksumSha256) throw new Error("MTGJSON AllPrintings checksum 不匹配");
      const counts = withinTransaction(this.database, () => this.appendSnapshot(runId, source!, startedAt));
      this.database.prepare("UPDATE price_sync_runs SET status = 'succeeded', mapped_skus = ?, priced_skus = ?, unpriced_skus = ?, mapping_failed_skus = ?, completed_at = ? WHERE id = ?").run(counts.mapped, counts.priced, counts.unpriced, counts.mappingFailed, new Date().toISOString(), runId);
      this.database.prepare("INSERT INTO price_sync_state (singleton, latest_successful_run_id, updated_at) VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET latest_successful_run_id = excluded.latest_successful_run_id, updated_at = excluded.updated_at").run(runId, new Date().toISOString());
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
      const failureCode = error instanceof MtgjsonChecksumMismatchError ? error.code : null;
      this.database.prepare("INSERT INTO price_sync_runs (id, source, source_version, prices_uri, mapping_uri, prices_checksum_sha256, mapping_checksum_sha256, status, checksum_verification, failure_code, failure_reason, started_at, completed_at) VALUES (?, 'mtgjson-cardmarket', ?, ?, ?, ?, ?, 'failed', 'not_verified', ?, ?, ?, ?)").run(runId, source?.version ?? "unavailable", source?.pricesUri ?? "unavailable", source?.mappingUri ?? "unavailable", source?.pricesChecksumSha256 ?? "unavailable", source?.mappingChecksumSha256 ?? "unavailable", failureCode, reason, startedAt, new Date().toISOString());
      throw error;
    }
  }

  private appendSnapshot(runId: string, source: MtgjsonPriceSource, now: string) {
    this.database.prepare("INSERT INTO price_sync_runs (id, source, source_version, prices_uri, mapping_uri, prices_checksum_sha256, mapping_checksum_sha256, status, checksum_verification, started_at) VALUES (?, 'mtgjson-cardmarket', ?, ?, ?, ?, ?, 'running', ?, ?)").run(runId, source.version, source.pricesUri, source.mappingUri, source.pricesChecksumSha256, source.mappingChecksumSha256, source.checksumVerification, now);
    const skus = this.database.prepare("SELECT sku.id, printing.scryfall_id, sku.finish FROM card_skus sku JOIN card_printings printing ON printing.id = sku.printing_id WHERE sku.source = 'scryfall'").all() as CatalogSku[];
    const candidates = new Map<string, typeof source.mappings>();
    for (const mapping of source.mappings) { const key = `${mapping.scryfallId}:${mapping.finish}`; candidates.set(key, [...(candidates.get(key) ?? []), mapping]); }
    const insertMapping = this.database.prepare("INSERT INTO price_sku_mappings (id, sync_run_id, sku_id, scryfall_id, mtgjson_uuid, finish, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const insertSnapshot = this.database.prepare("INSERT INTO price_snapshot_entries (id, sync_run_id, sku_id, mapping_id, mtgjson_uuid, finish, price_type, currency, price_amount, availability, unavailable_reason, captured_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const setTradable = this.database.prepare("UPDATE card_skus SET tradable = ?, updated_at = ? WHERE id = ?"); let mapped = 0; let priced = 0; let unpriced = 0; let mappingFailed = 0;
    for (const sku of skus) {
      const found = candidates.get(`${sku.scryfall_id}:${sku.finish}`) ?? [];
      if (found.length !== 1) { insertSnapshot.run(randomUUID(), runId, sku.id, null, null, sku.finish, sku.finish === "nonfoil" ? "normal" : sku.finish, "EUR", null, "mapping_failed", found.length ? "duplicate_mapping" : "missing_mapping", now, now); setTradable.run(0, now, sku.id); mappingFailed += 1; continue; }
      const mapping = found[0]!; const mappingId = randomUUID(); insertMapping.run(mappingId, runId, sku.id, mapping.scryfallId, mapping.mtgjsonUuid, mapping.finish, now); mapped += 1;
      const priceType = sku.finish === "nonfoil" ? "normal" : sku.finish; const price = source.prices.get(`${mapping.mtgjsonUuid}:${priceType}`);
      if (!price || price.currency !== "EUR" || price.amount === null) { insertSnapshot.run(randomUUID(), runId, sku.id, mappingId, mapping.mtgjsonUuid, sku.finish, priceType, "EUR", null, "no_price", "missing_or_zero_cardmarket_eur", now, now); setTradable.run(0, now, sku.id); unpriced += 1; continue; }
      insertSnapshot.run(randomUUID(), runId, sku.id, mappingId, mapping.mtgjsonUuid, sku.finish, priceType, "EUR", cents(price.amount), "priced", null, now, now); setTradable.run(1, now, sku.id); priced += 1;
    }
    return { mapped, priced, unpriced, mappingFailed };
  }
}
