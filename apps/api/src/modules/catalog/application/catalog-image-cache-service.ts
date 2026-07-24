import type Database from "better-sqlite3";
import type { CatalogImageCache } from "../../../platform/external/scryfall/scryfall-bulk-client.js";

export type CatalogImageCacheRequest =
  | { scope: "single"; skuId: string }
  | { scope: "set"; setCode: string };

type CacheCandidate = { printing_id: string; source_url: string };

/**
 * 目录同步只写元数据；本用例只读取既有目录并补齐本地图片，绝不重新下载 Bulk
 * 或删除/替换任何卡牌、SKU 与现有缓存记录。
 */
export class CatalogImageCacheService {
  constructor(private readonly database: Database.Database, private readonly imageCache: CatalogImageCache) {}

  async cache(request: CatalogImageCacheRequest): Promise<void> {
    const candidates = request.scope === "single" ? this.findSingle(request.skuId) : this.findSet(request.setCode);
    if (candidates.length === 0) {
      if (request.scope === "single") throw new Error("指定 SKU 不存在、不是 Scryfall 印刷，或没有可缓存的图片");
      return;
    }
    for (const candidate of candidates) await this.cacheOne(candidate);
  }

  private findSingle(skuId: string): CacheCandidate[] {
    return this.database.prepare(
      `SELECT p.id AS printing_id, image.source_url
       FROM card_skus sku
       JOIN card_printings p ON p.id = sku.printing_id
       LEFT JOIN card_image_cache image ON image.printing_id = p.id
       WHERE sku.id = ? AND p.source = 'scryfall' AND image.source_url IS NOT NULL
         AND (image.status IS NULL OR image.status <> 'cached')
       LIMIT 1`
    ).all(skuId) as CacheCandidate[];
  }

  private findSet(setCode: string): CacheCandidate[] {
    return this.database.prepare(
      `SELECT p.id AS printing_id, image.source_url
       FROM card_printings p
       JOIN card_sets s ON s.id = p.set_id
       LEFT JOIN card_image_cache image ON image.printing_id = p.id
       WHERE s.code = ? AND p.source = 'scryfall' AND image.source_url IS NOT NULL
         AND (image.status IS NULL OR image.status <> 'cached')
       ORDER BY p.name COLLATE NOCASE, p.collector_number`
    ).all(setCode) as CacheCandidate[];
  }

  private async cacheOne(candidate: CacheCandidate): Promise<void> {
    const now = new Date().toISOString();
    try {
      const cached = await this.imageCache.cache(candidate.printing_id, candidate.source_url);
      this.database.prepare(
        `UPDATE card_image_cache
         SET cache_path = ?, status = 'cached', checksum = ?, cached_at = ?, failure_reason = NULL, updated_at = ?
         WHERE printing_id = ?`
      ).run(cached.path, cached.checksum, now, now, candidate.printing_id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.database.prepare(
        "UPDATE card_image_cache SET status = 'failed', failure_reason = ?, updated_at = ? WHERE printing_id = ?"
      ).run(reason.slice(0, 1000), now, candidate.printing_id);
    }
  }
}
