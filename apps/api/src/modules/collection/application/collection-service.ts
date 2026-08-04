import type Database from "better-sqlite3";
import type { CollectionAlbumDto, Page } from "@mtg-market/contracts";

type SetGroupRow = { set_id: string; set_code: string; set_name: string };
type TotalRow = { set_code: string; total_sku_count: number };
type CollectedRow = { set_code: string; collected_sku_count: number };
type UncollectedRow = { name: string; set_code: string; collector_number: string; rarity: string };

export type AlbumFilters = {
  onlyHeld: boolean;
  cursor?: string | undefined;
  limit: number;
};

/**
 * I33B：收藏图鉴只读聚合。按系列分组图鉴、每系列已收集/全部 SKU 数与完成度、未收集卡位
 * 列表（用于灰影占位），数据全部来自目录与库存快照，不写任何经济表；分页按系列排序。
 * 完成度按「该系列全部印刷×工艺 SKU」与玩家已持有（quantity > 0）的不同 SKU 整数计算，
 * 同一印刷任一工艺已持有即视为已收集，浏览器不得自行统计或估值。
 */
export class CollectionService {
  constructor(private readonly database: Database.Database) {}

  album(userId: string, filters: AlbumFilters): CollectionAlbumDto {
    const offset = filters.cursor ? Number.parseInt(filters.cursor, 10) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("收藏图鉴分页游标无效");

    const totals = new Map((this.database.prepare(
      `SELECT s.code AS set_code, COUNT(*) AS total_sku_count
       FROM card_skus sku JOIN card_printings p ON p.id = sku.printing_id JOIN card_sets s ON s.id = p.set_id
       GROUP BY s.code`
    ).all() as TotalRow[]).map((row) => [row.set_code, row.total_sku_count]));

    const collected = new Map((this.database.prepare(
      `SELECT s.code AS set_code, COUNT(DISTINCT sku.id) AS collected_sku_count
       FROM inventory_holdings h
       JOIN card_skus sku ON sku.id = h.sku_id
       JOIN card_printings p ON p.id = sku.printing_id
       JOIN card_sets s ON s.id = p.set_id
       WHERE h.user_id = ? AND h.quantity > 0
       GROUP BY s.code`
    ).all(userId) as CollectedRow[]).map((row) => [row.set_code, row.collected_sku_count]));

    // 全部系列：包括未持有的系列（完成度 0），除非 onlyHeld 只展示已持有系列。
    const sets = this.database.prepare(
      "SELECT id AS set_id, code AS set_code, name AS set_name FROM card_sets ORDER BY code COLLATE NOCASE, id"
    ).all() as SetGroupRow[];

    const setCodes = sets.map((set) => set.set_code);
    const placeholders = setCodes.map(() => "?").join(", ");
    // 未收集卡位：该系列已持有 SKU 对应的印刷集合之外的全部印刷。按印刷去重（任一工艺持有即已收集）。
    const uncollectedRows = this.database.prepare(
      `SELECT p.name, s.code AS set_code, p.collector_number, p.rarity
       FROM card_printings p JOIN card_sets s ON s.id = p.set_id
       WHERE s.code IN (${placeholders})
         AND p.id NOT IN (
           SELECT DISTINCT p2.id FROM inventory_holdings h
           JOIN card_skus sku ON sku.id = h.sku_id
           JOIN card_printings p2 ON p2.id = sku.printing_id
           JOIN card_sets s2 ON s2.id = p2.set_id
           WHERE h.user_id = ? AND h.quantity > 0 AND s2.code = s.code
         )
       ORDER BY p.name COLLATE NOCASE, p.collector_number, p.id`
    ).all(...setCodes, userId) as UncollectedRow[];
    const uncollectedBySet = new Map<string, UncollectedRow[]>();
    for (const row of uncollectedRows) {
      const list = uncollectedBySet.get(row.set_code) ?? [];
      list.push(row);
      uncollectedBySet.set(row.set_code, list);
    }

    const groups = sets.map((set) => {
      const totalSkuCount = totals.get(set.set_code) ?? 0;
      const collectedSkuCount = collected.get(set.set_code) ?? 0;
      const completionBasisPoints = totalSkuCount === 0 ? 0 : Math.min(10_000, Math.floor((collectedSkuCount * 10_000) / totalSkuCount));
      return {
        setCode: set.set_code,
        setName: set.set_name,
        collectedSkuCount,
        totalSkuCount,
        completionBasisPoints,
        uncollectedCards: (uncollectedBySet.get(set.set_code) ?? []).map((card) => ({
          name: card.name,
          setCode: card.set_code,
          collectorNumber: card.collector_number,
          rarity: card.rarity
        }))
      };
    });
    const filtered = filters.onlyHeld ? groups.filter((group) => group.collectedSkuCount > 0) : groups;
    const paged: Page<CollectionAlbumDto["sets"]["items"][number]> = {
      items: filtered.slice(offset, offset + filters.limit),
      page: {
        total: filtered.length,
        hasMore: offset + filters.limit < filtered.length,
        nextCursor: offset + filters.limit < filtered.length ? String(offset + filters.limit) : null
      }
    };
    return { sets: paged };
  }
}
