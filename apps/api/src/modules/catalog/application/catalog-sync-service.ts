import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { withinTransaction } from "@mtg-market/database";
import { type CatalogImageCache, type ScryfallBulkCard, type ScryfallBulkClient, scryfallPrintingId } from "../../../platform/external/scryfall/scryfall-bulk-client.js";

type SyncPayload = { cacheImageScryfallIds?: string[]; expectedChecksumSha256?: string };
type SyncRow = { id: string; source_version: string; checksum_sha256: string; enabled_sets_json: string; status: "running" | "succeeded" | "failed"; imported_printings: number; imported_skus: number; cached_images: number; diff_json: string; failure_reason: string | null; started_at: string; completed_at: string | null };

export type CatalogSyncStatus = { latestSuccessful: Omit<SyncRow, "status"> | null; current: SyncRow | null };

function requireCard(card: ScryfallBulkCard): Required<Pick<ScryfallBulkCard, "id" | "set" | "set_name" | "name" | "collector_number">> & ScryfallBulkCard {
  if (!card || typeof card.id !== "string" || typeof card.set !== "string" || typeof card.set_name !== "string" || typeof card.name !== "string" || typeof card.collector_number !== "string") throw new Error("Scryfall 卡牌 Schema 缺少必要字段");
  return card as Required<Pick<ScryfallBulkCard, "id" | "set" | "set_name" | "name" | "collector_number">> & ScryfallBulkCard;
}

/** 同步先完整下载/解析，再在一个短事务替换 Scryfall 来源行；异常永远不会清空上个成功目录。 */
export class CatalogSyncService {
  constructor(private readonly database: Database.Database, private readonly client: ScryfallBulkClient, private readonly enabledSetCodes: readonly string[], private readonly imageCache: CatalogImageCache) {}

  status(): CatalogSyncStatus {
    const current = this.database.prepare("SELECT * FROM catalog_sync_runs ORDER BY started_at DESC, rowid DESC LIMIT 1").get() as SyncRow | undefined;
    const latest = this.database.prepare("SELECT r.* FROM catalog_sync_state s JOIN catalog_sync_runs r ON r.id = s.latest_successful_run_id WHERE s.singleton = 1").get() as SyncRow | undefined;
    const strip = (row: SyncRow | undefined) => row ? ({ id: row.id, source_version: row.source_version, checksum_sha256: row.checksum_sha256, enabled_sets_json: row.enabled_sets_json, imported_printings: row.imported_printings, imported_skus: row.imported_skus, cached_images: row.cached_images, diff_json: row.diff_json, failure_reason: row.failure_reason, started_at: row.started_at, completed_at: row.completed_at }) : null;
    return { latestSuccessful: strip(latest), current: current ?? null };
  }

  async synchronize(payload: SyncPayload = {}): Promise<void> {
    const startedAt = new Date().toISOString(); const runId = randomUUID();
    let sourceVersion = "unavailable"; let sourceUri = "unavailable"; let checksum = "unavailable";
    try {
      if (this.enabledSetCodes.length === 0) throw new Error("未配置 CATALOG_ENABLED_SET_CODES，拒绝导入全部 Scryfall Bulk Data");
      const source = await this.client.download(); sourceVersion = source.version; sourceUri = source.downloadUri; checksum = source.checksumSha256;
      if (payload.expectedChecksumSha256 && payload.expectedChecksumSha256 !== checksum) throw new Error("Scryfall Bulk 文件 checksum 不匹配");
      const cards = source.cards.filter((raw) => { const card = requireCard(raw); return this.enabledSetCodes.includes(card.set.toUpperCase()); }).map(requireCard);
      if (cards.length === 0) throw new Error("启用系列在 Scryfall Bulk Data 中没有匹配印刷");
      const seen = new Set<string>(); for (const card of cards) { scryfallPrintingId(card.id); if (seen.has(card.id)) throw new Error(`Scryfall Bulk Data 含重复印刷：${card.id}`); seen.add(card.id); }
      const requestedImages = new Set(payload.cacheImageScryfallIds ?? []);
      const imageResults = new Map<string, { path: string; checksum: string; sourceUrl: string }>();
      for (const card of cards) if (requestedImages.has(card.id) && card.image_uris?.normal) {
        const cached = await this.imageCache.cache(card.id, card.image_uris.normal); imageResults.set(card.id, { ...cached, sourceUrl: card.image_uris.normal });
      }
      const diff = withinTransaction(this.database, () => this.replaceCatalog(runId, sourceVersion, sourceUri, checksum, cards, imageResults, startedAt));
      this.database.prepare("UPDATE catalog_sync_runs SET status = 'succeeded', imported_printings = ?, imported_skus = ?, cached_images = ?, diff_json = ?, completed_at = ? WHERE id = ?").run(diff.printings, diff.skus, imageResults.size, JSON.stringify(diff), new Date().toISOString(), runId);
      this.database.prepare("INSERT INTO catalog_sync_state (singleton, latest_successful_run_id, updated_at) VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET latest_successful_run_id = excluded.latest_successful_run_id, updated_at = excluded.updated_at").run(runId, new Date().toISOString());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.database.prepare("INSERT INTO catalog_sync_runs (id, source, source_version, source_uri, checksum_sha256, enabled_sets_json, status, diff_json, failure_reason, started_at, completed_at) VALUES (?, 'scryfall-bulk', ?, ?, ?, ?, 'failed', '{}', ?, ?, ?)").run(runId, sourceVersion, sourceUri, checksum, JSON.stringify(this.enabledSetCodes), message.slice(0, 1000), startedAt, new Date().toISOString());
      throw error;
    }
  }

  private replaceCatalog(runId: string, version: string, uri: string, checksum: string, cards: ScryfallBulkCard[], images: Map<string, { path: string; checksum: string; sourceUrl: string }>, startedAt: string): { printings: number; skus: number; added: number; removed: number } {
    const before = (this.database.prepare("SELECT COUNT(*) AS count FROM card_printings WHERE source = 'scryfall'").get() as { count: number }).count;
    this.database.prepare("INSERT INTO catalog_sync_runs (id, source, source_version, source_uri, checksum_sha256, enabled_sets_json, status, diff_json, started_at) VALUES (?, 'scryfall-bulk', ?, ?, ?, ?, 'running', '{}', ?)").run(runId, version, uri, checksum, JSON.stringify(this.enabledSetCodes), startedAt);
    this.database.prepare("DELETE FROM card_image_cache WHERE printing_id IN (SELECT id FROM card_printings WHERE source = 'scryfall')").run();
    this.database.prepare("DELETE FROM card_skus WHERE source = 'scryfall'").run(); this.database.prepare("DELETE FROM card_printings WHERE source = 'scryfall'").run(); this.database.prepare("DELETE FROM card_sets WHERE source = 'scryfall'").run();
    const insertSet = this.database.prepare("INSERT INTO card_sets (id, code, name, released_at, source, source_reference, created_at) VALUES (?, ?, ?, ?, 'scryfall', ?, ?)");
    const insertPrinting = this.database.prepare("INSERT INTO card_printings (id, set_id, name, collector_number, scryfall_id, oracle_text, rarity, legalities_json, artist, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scryfall', ?, 0, ?, ?)");
    const insertSku = this.database.prepare("INSERT INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, ?, 0, 'scryfall', ?, 0, ?, ?)");
    const insertImage = this.database.prepare("INSERT INTO card_image_cache (id, printing_id, source_url, cache_path, status, checksum, cached_at, failure_reason, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const sets = new Map<string, string>(); let skus = 0;
    for (const card of cards) {
      const setCode = card.set.toUpperCase(); let setId = sets.get(setCode); if (!setId) { setId = randomUUID(); sets.set(setCode, setId); insertSet.run(setId, setCode, card.set_name, card.released_at ?? null, `${version}:${setCode}`, startedAt); }
      const printingId = scryfallPrintingId(card.id); insertPrinting.run(printingId, setId, card.name, card.collector_number, card.id, card.oracle_text ?? null, card.rarity ?? "unknown", JSON.stringify(card.legalities ?? {}), card.artist ?? null, card.id, startedAt, startedAt);
      const finishes = (card.finishes ?? []).filter((finish): finish is "nonfoil" | "foil" | "etched" => finish === "nonfoil" || finish === "foil" || finish === "etched");
      if (finishes.length === 0) throw new Error(`Scryfall 卡牌 Schema 缺少可支持工艺：${card.id}`);
      for (const finish of finishes) { insertSku.run(randomUUID(), printingId, finish, card.id, startedAt, startedAt); skus += 1; }
      const image = images.get(card.id); insertImage.run(randomUUID(), printingId, image?.sourceUrl ?? card.image_uris?.normal ?? null, image?.path ?? null, image ? "cached" : "missing", image?.checksum ?? null, image ? startedAt : null, null, startedAt);
    }
    return { printings: cards.length, skus, added: cards.length, removed: before };
  }
}
