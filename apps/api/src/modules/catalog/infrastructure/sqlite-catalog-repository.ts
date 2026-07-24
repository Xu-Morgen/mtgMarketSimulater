import type Database from "better-sqlite3";
import { basename } from "node:path";
import type { CatalogSkuDetailDto, CatalogSkuDto, Page } from "@mtg-market/contracts";

type CatalogRow = {
  sku_id: string; printing_id: string; scryfall_id: string | null; name: string; set_code: string; set_name: string;
  collector_number: string; finish: "nonfoil" | "foil" | "etched"; rarity: string; legalities_json: string;
  sku_source: "scryfall" | "manual-test"; sku_source_reference: string | null; sku_manual_exception: number;
  tradable: number; image_path: string | null; image_source_url: string | null; image_status: "missing" | "cached" | "failed" | null;
  image_cached_at: string | null; oracle_text: string | null; artist: string | null; released_at: string | null;
};

export type CatalogFilters = { query?: string | undefined; setCode?: string | undefined; rarity?: string | undefined; finish?: "nonfoil" | "foil" | "etched" | undefined; cursor?: string | undefined; limit: number };

function publicImagePath(cachePath: string | null): string | null {
  return cachePath ? `/v1/catalog/images/${basename(cachePath)}` : null;
}
function image(row: CatalogRow): CatalogSkuDto["image"] {
  return { path: publicImagePath(row.image_path), sourceUrl: row.image_source_url, status: row.image_status ?? "missing", cachedAt: row.image_cached_at };
}
function item(row: CatalogRow): CatalogSkuDto {
  return {
    id: row.sku_id, printingId: row.printing_id, scryfallId: row.scryfall_id ?? `manual:${row.printing_id}`, name: row.name,
    setCode: row.set_code, setName: row.set_name, collectorNumber: row.collector_number, finish: row.finish,
    rarity: row.rarity, legalities: JSON.parse(row.legalities_json) as Record<string, string>, imagePath: publicImagePath(row.image_path),
    tradable: row.tradable === 1, source: row.sku_source, sourceReference: row.sku_source_reference,
    isManualException: row.sku_manual_exception === 1, image: image(row)
  };
}
function detail(row: CatalogRow): CatalogSkuDetailDto { return { ...item(row), oracleText: row.oracle_text, artist: row.artist, releasedAt: row.released_at }; }

/** I08B 目录只读 SQLite 适配器；Scryfall 写入留待 I09 的同步任务实现。 */
export class SqliteCatalogRepository {
  constructor(private readonly database: Database.Database) {}

  list(filters: CatalogFilters): Page<CatalogSkuDto> {
    const where: string[] = []; const values: unknown[] = [];
    if (filters.query) { where.push("lower(p.name) LIKE lower(?)"); values.push(`%${filters.query}%`); }
    if (filters.setCode) { where.push("s.code = ?"); values.push(filters.setCode); }
    if (filters.rarity) { where.push("p.rarity = ?"); values.push(filters.rarity); }
    if (filters.finish) { where.push("sku.finish = ?"); values.push(filters.finish); }
    const offset = filters.cursor ? Number.parseInt(filters.cursor, 10) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("目录分页游标无效");
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (this.database.prepare(`SELECT COUNT(*) AS count FROM card_skus sku JOIN card_printings p ON p.id = sku.printing_id JOIN card_sets s ON s.id = p.set_id ${clause}`).get(...values) as { count: number }).count;
    const rows = this.database.prepare(`${this.selectSql()} ${clause} ORDER BY p.name COLLATE NOCASE, s.code, p.collector_number, sku.finish LIMIT ? OFFSET ?`).all(...values, filters.limit + 1, offset) as CatalogRow[];
    const hasMore = rows.length > filters.limit;
    return { items: rows.slice(0, filters.limit).map(item), page: { total, hasMore, nextCursor: hasMore ? String(offset + filters.limit) : null } };
  }

  findBySkuId(skuId: string): CatalogSkuDetailDto | null {
    const row = this.database.prepare(`${this.selectSql()} WHERE sku.id = ?`).get(skuId) as CatalogRow | undefined;
    return row ? detail(row) : null;
  }

  private selectSql(): string {
    return `SELECT sku.id AS sku_id, p.id AS printing_id, p.scryfall_id, p.name, s.code AS set_code, s.name AS set_name,
      p.collector_number, sku.finish, p.rarity, p.legalities_json, sku.source AS sku_source,
      sku.source_reference AS sku_source_reference, sku.is_manual_exception AS sku_manual_exception, sku.tradable,
      image.cache_path AS image_path, image.source_url AS image_source_url, image.status AS image_status, image.cached_at AS image_cached_at,
      p.oracle_text, p.artist, s.released_at
      FROM card_skus sku JOIN card_printings p ON p.id = sku.printing_id JOIN card_sets s ON s.id = p.set_id
      LEFT JOIN card_image_cache image ON image.printing_id = p.id`;
  }
}
