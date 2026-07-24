import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "@mtg-market/database";
import { CatalogImageCache } from "../../../platform/external/scryfall/scryfall-bulk-client.js";
import { CatalogImageCacheService } from "./catalog-image-cache-service.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "mtg-image-cache-")); directories.push(directory);
  const database = openSqliteDatabase(join(directory, "test.db")); const now = "2026-07-24T00:00:00.000Z";
  database.prepare("INSERT INTO card_sets (id, code, name, released_at, source, source_reference, created_at) VALUES (?, 'ONE', 'One', NULL, 'scryfall', 'one', ?)").run("10000000-0000-4000-8000-000000000001", now);
  const printing = database.prepare("INSERT INTO card_printings (id, set_id, name, collector_number, scryfall_id, oracle_text, rarity, legalities_json, artist, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, 'rare', '{}', NULL, 'scryfall', ?, 0, ?, ?)");
  const image = database.prepare("INSERT INTO card_image_cache (id, printing_id, source_url, cache_path, status, checksum, cached_at, failure_reason, updated_at) VALUES (?, ?, ?, NULL, 'missing', NULL, NULL, NULL, ?)");
  const sku = database.prepare("INSERT INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'nonfoil', 0, 'scryfall', ?, 0, ?, ?)");
  for (const suffix of ["1", "2"]) { const id = `20000000-0000-4000-8000-00000000000${suffix}`; printing.run(id, "10000000-0000-4000-8000-000000000001", `Card ${suffix}`, suffix, `30000000-0000-4000-8000-00000000000${suffix}`, `source-${suffix}`, now, now); image.run(`40000000-0000-4000-8000-00000000000${suffix}`, id, `https://images.example.test/card-${suffix}.jpg`, now); sku.run(`50000000-0000-4000-8000-00000000000${suffix}`, id, `source-${suffix}`, now, now); }
  const cache = new CatalogImageCache(join(directory, "catalog"), "MTG-Market-Simulator/test", async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
  return { database, service: new CatalogImageCacheService(database, cache) };
}

describe("I09B 卡图本地缓存任务", () => {
  it("按单个 SKU 缓存图片并更新元数据，不重建目录", async () => {
    const { database, service } = fixture();
    await service.cache({ scope: "single", skuId: "50000000-0000-4000-8000-000000000001" });
    expect(database.prepare("SELECT status, cache_path, checksum FROM card_image_cache WHERE printing_id = ?").get("20000000-0000-4000-8000-000000000001")).toEqual(expect.objectContaining({ status: "cached", cache_path: "images/20000000-0000-4000-8000-000000000001.jpg" }));
    expect(database.prepare("SELECT COUNT(*) AS count FROM card_printings").get()).toEqual({ count: 2 }); database.close();
  });

  it("按系列补齐缺图；单张图片失败仅标记失败而不阻塞其余图片", async () => {
    const { database, service } = fixture();
    await service.cache({ scope: "set", setCode: "ONE" });
    expect(database.prepare("SELECT status, COUNT(*) AS count FROM card_image_cache GROUP BY status").all()).toEqual([{ status: "cached", count: 2 }]); database.close();
  });
});
