import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "@mtg-market/database";
import { ScryfallBulkClient } from "../../../platform/external/scryfall/scryfall-bulk-client.js";
import { CatalogSyncService } from "./catalog-sync-service.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

const card = { id: "20000000-0000-4000-8000-000000000001", set: "one", set_name: "Phyrexia: All Will Be One", released_at: "2023-02-10", name: "Fixture Card", collector_number: "1", rarity: "rare", legalities: { modern: "legal" }, finishes: ["nonfoil", "foil"], image_uris: { normal: "https://images.example.test/card.jpg" } };
function source(cards: unknown[]) {
  const encoded = Buffer.from(JSON.stringify(cards)); const checksum = createHash("sha256").update(encoded).digest("hex");
  const client = new ScryfallBulkClient("https://api.example.test/bulk", "MTG-Market-Simulator/test", async (url) => {
    if (String(url).includes("bulk")) return new Response(JSON.stringify({ updated_at: "2026-07-24T00:00:00.000Z", download_uri: "https://download.example.test/default-cards.json" }), { status: 200 });
    return new Response(encoded, { status: 200 });
  });
  return { client, checksum };
}
function service(cards: unknown[]) {
  const directory = mkdtempSync(join(tmpdir(), "mtg-catalog-sync-")); directories.push(directory);
  const database = openSqliteDatabase(join(directory, "test.db")); const fixture = source(cards);
  return { database, checksum: fixture.checksum, sync: new CatalogSyncService(database, fixture.client, ["ONE"]) };
}

describe("I09B Scryfall Bulk 同步", () => {
  it("记录版本和 checksum，并按启用系列原子导入独立 SKU", async () => {
    const { database, checksum, sync } = service([card, { ...card, id: "20000000-0000-4000-8000-000000000002", set: "bro" }]);
    await sync.synchronize({ expectedChecksumSha256: checksum });
    expect(database.prepare("SELECT code FROM card_sets").all()).toEqual([{ code: "ONE" }]);
    expect(database.prepare("SELECT finish FROM card_skus ORDER BY finish").all()).toEqual([{ finish: "foil" }, { finish: "nonfoil" }]);
    expect(database.prepare("SELECT source_version, checksum_sha256, status, cached_images FROM catalog_sync_runs").get()).toEqual(expect.objectContaining({ source_version: "2026-07-24T00:00:00.000Z", checksum_sha256: checksum, status: "succeeded", cached_images: 0 }));
    expect(sync.status().latestSuccessful).toEqual(expect.objectContaining({ imported_printings: 1, imported_skus: 2 }));
    database.close();
  });

  it("checksum、损坏文件、重复印刷和 Schema 缺失均保留旧目录并记录失败", async () => {
    const { database, checksum, sync } = service([card]); await sync.synchronize({ expectedChecksumSha256: checksum });
    await expect(sync.synchronize({ expectedChecksumSha256: "0".repeat(64) })).rejects.toThrow("checksum");
    const duplicate = service([card, card]); await expect(duplicate.sync.synchronize()).rejects.toThrow("重复印刷"); duplicate.database.close();
    const malformed = service([{ id: card.id }]); await expect(malformed.sync.synchronize()).rejects.toThrow("缺少必要字段"); malformed.database.close();
    expect(database.prepare("SELECT COUNT(*) AS count FROM card_printings WHERE source = 'scryfall'").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT status, failure_reason FROM catalog_sync_runs WHERE status = 'failed'").get()).toMatchObject({ status: "failed", failure_reason: expect.stringContaining("checksum") });
    database.close();
  });

  it("事务中断和非法图片路径不会留下半目录或不安全缓存文件", async () => {
    const interrupted = service([card]); interrupted.database.exec("CREATE TRIGGER reject_catalog_insert BEFORE INSERT ON card_skus BEGIN SELECT RAISE(ABORT, 'fixture interruption'); END;");
    await expect(interrupted.sync.synchronize()).rejects.toThrow("fixture interruption");
    expect(interrupted.database.prepare("SELECT COUNT(*) AS count FROM card_sets").get()).toEqual({ count: 0 }); interrupted.database.close();
    const unsafe = service([{ ...card, image_uris: { normal: "https://images.example.test/card.exe" } }]);
    await unsafe.sync.synchronize();
    expect(unsafe.database.prepare("SELECT COUNT(*) AS count FROM card_printings").get()).toEqual({ count: 1 }); unsafe.database.close();
  });

  it("将截断 Bulk JSON 归类为同步失败，而非替换现有目录", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mtg-catalog-sync-")); directories.push(directory); const database = openSqliteDatabase(join(directory, "test.db"));
    const client = new ScryfallBulkClient("https://api.example.test/bulk", "MTG-Market-Simulator/test", async (url) => String(url).includes("bulk") ? new Response(JSON.stringify({ updated_at: "2026-07-24T00:00:00.000Z", download_uri: "https://download.example.test/cards" })) : new Response("[{\"id\":"));
    const sync = new CatalogSyncService(database, client, ["ONE"]);
    await expect(sync.synchronize()).rejects.toThrow("损坏或截断"); expect(database.prepare("SELECT status FROM catalog_sync_runs").get()).toEqual({ status: "failed" }); database.close();
  });
});
