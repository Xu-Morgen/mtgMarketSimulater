import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "@mtg-market/database";
import { createApiApp } from "../../../app.js";
import { loadApiConfig } from "../../../config/environment.js";
import { PackService } from "../application/pack-service.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

async function createTestApp() {
  const directory = mkdtempSync(join(tmpdir(), "mtg-packs-")); directories.push(directory);
  const database = openSqliteDatabase(join(directory, "test.db"));
  const config = loadApiConfig({ APP_ENV: "test", SQLITE_PATH: join(directory, "test.db"), AUTH_JWT_SECRET: "test-only-secret-must-be-at-least-32-characters" });
  return { app: await createApiApp(config, database), database };
}

function seedCatalogAndPacks(database: ReturnType<typeof openSqliteDatabase>) {
  const now = "2026-07-26T00:00:00.000Z";
  const setId = "10000000-0000-4000-8000-000000000011";
  const printingId = "20000000-0000-4000-8000-000000000011";
  const commonSkuId = "30000000-0000-4000-8000-000000000011";
  const rareSkuId = "30000000-0000-4000-8000-000000000012";
  const activePackId = "40000000-0000-4000-8000-000000000011";
  const disabledPackId = "40000000-0000-4000-8000-000000000012";
  database.prepare("INSERT INTO card_sets (id, code, name, released_at, source, source_reference, created_at) VALUES (?, ?, ?, NULL, 'manual-test', 'fixture', ?)").run(setId, "PKT", "补充包测试系列", now);
  database.prepare("INSERT INTO card_printings (id, set_id, name, collector_number, scryfall_id, oracle_text, rarity, legalities_json, artist, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, ?, '{}', NULL, 'manual-test', 'fixture', 1, ?, ?)").run(printingId, setId, "测试卡", "1", "common", now, now);
  const sku = database.prepare("INSERT INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, ?, 0, 'manual-test', 'fixture', 1, ?, ?)");
  sku.run(commonSkuId, printingId, "nonfoil", now, now); sku.run(rareSkuId, printingId, "foil", now, now);
  const definition = JSON.stringify({ version: "pack/v1", pools: [{ id: "common", rarity: "common", candidates: [{ skuId: commonSkuId, weight: 1 }] }, { id: "rare", rarity: "rare", candidates: [{ skuId: rareSkuId, weight: 1 }] }], slots: [{ id: "regular", draws: 2, poolWeights: [{ poolId: "common", weight: 9 }, { poolId: "rare", weight: 1 }] }] });
  const pack = database.prepare("INSERT INTO booster_packs (id, code, name, description, price_amount, enabled, disabled_reason, active_rule_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pack/v1', ?, ?)");
  pack.run(activePackId, "PKT-01", "测试补充包", "由服务器配置的测试补充包", 500, 1, null, now, now);
  pack.run(disabledPackId, "PKT-02", "暂停补充包", null, 600, 0, "活动已结束", now, now);
  const rule = database.prepare("INSERT INTO booster_pack_rules (id, pack_id, version, definition_json, created_at, retired_at) VALUES (?, ?, 'pack/v1', ?, ?, NULL)");
  rule.run("50000000-0000-4000-8000-000000000011", activePackId, definition, now);
  rule.run("50000000-0000-4000-8000-000000000012", disabledPackId, definition, now);
  return { activePackId, disabledPackId };
}

async function authorization(app: Awaited<ReturnType<typeof createApiApp>>) {
  const response = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email: "packs@example.test", displayName: "开包玩家", password: "correct-horse-battery-staple" } });
  return `Bearer ${response.json().data.accessToken as string}`;
}

describe("I11B 补充包配置和规则引擎", () => {
  it("仅向认证玩家公示服务端价格、启用状态、规则版本和概率", async () => {
    const { app, database } = await createTestApp(); const { activePackId, disabledPackId } = seedCatalogAndPacks(database); const token = await authorization(app);
    const anonymous = await app.inject({ method: "GET", url: "/v1/packs" });
    const list = await app.inject({ method: "GET", url: "/v1/packs", headers: { authorization: token } });
    const detail = await app.inject({ method: "GET", url: `/v1/packs/${activePackId}`, headers: { authorization: token } });
    const disabled = await app.inject({ method: "GET", url: `/v1/packs/${disabledPackId}`, headers: { authorization: token } });
    const missing = await app.inject({ method: "GET", url: "/v1/packs/40000000-0000-4000-8000-000000000099", headers: { authorization: token } });
    expect(anonymous.json()).toMatchObject({ ok: false, error: { code: "AUTHENTICATION_INVALID" } });
    expect(list.json()).toEqual(expect.objectContaining({ ok: true, data: expect.objectContaining({ items: expect.arrayContaining([expect.objectContaining({ id: activePackId, price: { amount: 500, currency: "GAME_CREDIT" }, enabled: true, disabledReason: null, ruleVersion: "pack/v1", slots: [{ id: "regular", draws: 2, rarityProbabilities: [{ rarity: "common", probabilityBasisPoints: 9000 }, { rarity: "rare", probabilityBasisPoints: 1000 }] }] }), expect.objectContaining({ id: disabledPackId, enabled: false, disabledReason: "活动已结束" })]) }) }));
    expect(JSON.stringify(detail.json())).not.toContain("candidates");
    expect(JSON.stringify(detail.json())).not.toContain("randomSeed");
    expect(disabled.json()).toMatchObject({ ok: true, data: { pack: { enabled: false, disabledReason: "活动已结束" } } });
    expect(missing.json()).toMatchObject({ ok: false, error: { code: "RESOURCE_NOT_FOUND" } });
    await app.close(); database.close();
  });

  it("由服务端 CSPRNG 产生种子并只在审计存储中保存可重放结果", () => {
    const directory = mkdtempSync(join(tmpdir(), "mtg-pack-audit-")); directories.push(directory);
    const database = openSqliteDatabase(join(directory, "test.db")); const { activePackId, disabledPackId } = seedCatalogAndPacks(database);
    const seed = "a".repeat(64); const service = new PackService(database, () => seed);
    const result = service.generateAuditedResult(activePackId, "2026-07-26T01:00:00.000Z");
    expect(result).toEqual(expect.objectContaining({ randomSeedHash: expect.stringMatching(/^[a-f0-9]{64}$/), result: expect.objectContaining({ ruleVersion: "pack/v1", cards: expect.arrayContaining([expect.objectContaining({ skuId: expect.any(String) })]) }) }));
    expect(service.generateAuditedResult(disabledPackId)).toBe("disabled");
    expect(service.generateAuditedResult("40000000-0000-4000-8000-000000000099")).toBe("not-found");
    expect(database.prepare("SELECT random_seed, random_seed_hash, result_summary_json FROM pack_rule_replays").get()).toMatchObject({ random_seed: seed, random_seed_hash: (result as Exclude<typeof result, string>).randomSeedHash, result_summary_json: expect.stringContaining("pack/v1") });
    database.close();
  });
});
