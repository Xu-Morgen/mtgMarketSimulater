import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "@mtg-market/database";
import { createApiApp } from "../../../app.js";
import { loadApiConfig } from "../../../config/environment.js";
import { PackService } from "../application/pack-service.js";

const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
);

async function createTestApp() {
  const directory = mkdtempSync(join(tmpdir(), "mtg-packs-"));
  directories.push(directory);
  const database = openSqliteDatabase(join(directory, "test.db"));
  const config = loadApiConfig({
    APP_ENV: "test",
    SQLITE_PATH: join(directory, "test.db"),
    AUTH_JWT_SECRET: "test-only-secret-must-be-at-least-32-characters"
  });
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
  database
    .prepare(
      "INSERT INTO card_sets (id, code, name, released_at, source, source_reference, created_at) VALUES (?, ?, ?, NULL, 'manual-test', 'fixture', ?)"
    )
    .run(setId, "PKT", "补充包测试系列", now);
  database
    .prepare(
      "INSERT INTO card_printings (id, set_id, name, collector_number, scryfall_id, oracle_text, rarity, legalities_json, artist, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, ?, '{}', NULL, 'manual-test', 'fixture', 1, ?, ?)"
    )
    .run(printingId, setId, "测试卡", "1", "common", now, now);
  const sku = database.prepare(
    "INSERT INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, ?, 0, 'manual-test', 'fixture', 1, ?, ?)"
  );
  sku.run(commonSkuId, printingId, "nonfoil", now, now);
  sku.run(rareSkuId, printingId, "foil", now, now);
  const definition = JSON.stringify({
    version: "pack/v1",
    pools: [
      { id: "common", rarity: "common", candidates: [{ skuId: commonSkuId, weight: 1 }] },
      { id: "rare", rarity: "rare", candidates: [{ skuId: rareSkuId, weight: 1 }] }
    ],
    slots: [
      {
        id: "regular",
        draws: 2,
        poolWeights: [
          { poolId: "common", weight: 9 },
          { poolId: "rare", weight: 1 }
        ]
      }
    ]
  });
  const pack = database.prepare(
    "INSERT INTO booster_packs (id, code, name, description, price_amount, enabled, disabled_reason, active_rule_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pack/v1', ?, ?)"
  );
  pack.run(
    activePackId,
    "PKT-01",
    "测试补充包",
    "由服务器配置的测试补充包",
    500,
    1,
    null,
    now,
    now
  );
  pack.run(disabledPackId, "PKT-02", "暂停补充包", null, 600, 0, "活动已结束", now, now);
  const rule = database.prepare(
    "INSERT INTO booster_pack_rules (id, pack_id, version, definition_json, created_at, retired_at) VALUES (?, ?, 'pack/v1', ?, ?, NULL)"
  );
  rule.run("50000000-0000-4000-8000-000000000011", activePackId, definition, now);
  rule.run("50000000-0000-4000-8000-000000000012", disabledPackId, definition, now);
  return { activePackId, disabledPackId };
}

async function authorization(app: Awaited<ReturnType<typeof createApiApp>>) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    payload: {
      email: "packs@example.test",
      displayName: "开包玩家",
      password: "correct-horse-battery-staple"
    }
  });
  return `Bearer ${response.json().data.accessToken as string}`;
}

async function createArchive(
  app: Awaited<ReturnType<typeof createApiApp>>,
  token: string,
  key = "archive-key-0001"
) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/archive",
    headers: { authorization: token, "idempotency-key": key },
    payload: {}
  });
  expect(response.statusCode).toBe(201);
}

describe("I11B 补充包配置和规则引擎", () => {
  it("仅向认证玩家公示服务端价格、启用状态、规则版本和概率", async () => {
    const { app, database } = await createTestApp();
    const { activePackId, disabledPackId } = seedCatalogAndPacks(database);
    const token = await authorization(app);
    const anonymous = await app.inject({ method: "GET", url: "/v1/packs" });
    const list = await app.inject({
      method: "GET",
      url: "/v1/packs",
      headers: { authorization: token }
    });
    const detail = await app.inject({
      method: "GET",
      url: `/v1/packs/${activePackId}`,
      headers: { authorization: token }
    });
    const disabled = await app.inject({
      method: "GET",
      url: `/v1/packs/${disabledPackId}`,
      headers: { authorization: token }
    });
    const missing = await app.inject({
      method: "GET",
      url: "/v1/packs/40000000-0000-4000-8000-000000000099",
      headers: { authorization: token }
    });
    expect(anonymous.json()).toMatchObject({
      ok: false,
      error: { code: "AUTHENTICATION_INVALID" }
    });
    expect(list.json()).toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          items: expect.arrayContaining([
            expect.objectContaining({
              id: activePackId,
              price: { amount: 500, currency: "GAME_CREDIT" },
              enabled: true,
              disabledReason: null,
              ruleVersion: "pack/v1",
              slots: [
                {
                  id: "regular",
                  draws: 2,
                  rarityProbabilities: [
                    { rarity: "common", probabilityBasisPoints: 9000 },
                    { rarity: "rare", probabilityBasisPoints: 1000 }
                  ]
                }
              ]
            }),
            expect.objectContaining({
              id: disabledPackId,
              enabled: false,
              disabledReason: "活动已结束"
            })
          ])
        })
      })
    );
    expect(JSON.stringify(detail.json())).not.toContain("candidates");
    expect(JSON.stringify(detail.json())).not.toContain("randomSeed");
    expect(disabled.json()).toMatchObject({
      ok: true,
      data: { pack: { enabled: false, disabledReason: "活动已结束" } }
    });
    expect(missing.json()).toMatchObject({ ok: false, error: { code: "RESOURCE_NOT_FOUND" } });
    await app.close();
    database.close();
  });

  it("由服务端 CSPRNG 产生种子并只在审计存储中保存可重放结果", () => {
    const directory = mkdtempSync(join(tmpdir(), "mtg-pack-audit-"));
    directories.push(directory);
    const database = openSqliteDatabase(join(directory, "test.db"));
    const { activePackId, disabledPackId } = seedCatalogAndPacks(database);
    const seed = "a".repeat(64);
    const service = new PackService(database, () => seed);
    const result = service.generateAuditedResult(activePackId, "2026-07-26T01:00:00.000Z");
    expect(result).toEqual(
      expect.objectContaining({
        randomSeedHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        result: expect.objectContaining({
          ruleVersion: "pack/v1",
          cards: expect.arrayContaining([expect.objectContaining({ skuId: expect.any(String) })])
        })
      })
    );
    expect(service.generateAuditedResult(disabledPackId)).toBe("disabled");
    expect(service.generateAuditedResult("40000000-0000-4000-8000-000000000099")).toBe("not-found");
    expect(
      database
        .prepare("SELECT random_seed, random_seed_hash, result_summary_json FROM pack_rule_replays")
        .get()
    ).toMatchObject({
      random_seed: seed,
      random_seed_hash: (result as Exclude<typeof result, string>).randomSeedHash,
      result_summary_json: expect.stringContaining("pack/v1")
    });
    database.close();
  });
});

describe("I12B 商店购买与服务端开包", () => {
  it("在同一事务中扣款、入库、记录开包和 pack.opened 事实事件，并可按幂等键重放", async () => {
    const { app, database } = await createTestApp();
    const { activePackId, disabledPackId } = seedCatalogAndPacks(database);
    const token = await authorization(app);
    await createArchive(app, token);
    const preview = await app.inject({
      method: "GET",
      url: `/v1/store/packs/${activePackId}/purchase-preview`,
      headers: { authorization: token }
    });
    const shop = await app.inject({
      method: "GET",
      url: "/v1/store/packs",
      headers: { authorization: token }
    });
    expect(preview.json()).toMatchObject({
      ok: true,
      data: {
        preview: {
          ruleVersion: "pack/v1",
          cost: { amount: 500 },
          canPurchase: true,
          unavailableReason: null
        }
      }
    });
    expect(shop.json().data.items).toHaveLength(1);
    const request = {
      method: "POST" as const,
      url: `/v1/packs/${activePackId}/open`,
      headers: { authorization: token, "idempotency-key": "open-pack-key-0001" },
      payload: { ruleVersion: "pack/v1" }
    };
    const [first, replay] = await Promise.all([app.inject(request), app.inject(request)]);
    expect([first.statusCode, replay.statusCode].sort()).toEqual([200, 201]);
    const result = (first.statusCode === 201 ? first : replay).json().data.opening;
    expect(result).toMatchObject({
      packId: activePackId,
      spent: { amount: 500, currency: "GAME_CREDIT" },
      profitLoss: { priceStatus: "unavailable_until_i17", referenceValue: null, gameValue: null }
    });
    expect(
      result.received.reduce((sum: number, card: { quantity: number }) => sum + card.quantity, 0)
    ).toBe(2);
    expect(
      result.received.reduce(
        (sum: number, card: { cost: { amount: number } }) => sum + card.cost.amount,
        0
      )
    ).toBe(500);
    expect(
      database.prepare("SELECT total_amount, available_amount, frozen_amount FROM accounts").get()
    ).toEqual({ total_amount: 9500, available_amount: 9500, frozen_amount: 0 });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM inventory_entries WHERE reason = 'pack_opened'")
        .get()
    ).toEqual({ count: 2 });
    expect(
      database.prepare("SELECT event_type, payload_json FROM fact_events").get()
    ).toMatchObject({
      event_type: "pack.opened",
      payload_json: expect.stringContaining(activePackId)
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM pack_openings").get()).toEqual({
      count: 1
    });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM ledger_entries WHERE reason = 'pack_purchase'")
        .get()
    ).toEqual({ count: 1 });
    const history = await app.inject({
      method: "GET",
      url: "/v1/pack-openings",
      headers: { authorization: token }
    });
    expect(history.json()).toMatchObject({
      ok: true,
      data: { items: [expect.objectContaining({ id: result.id })] }
    });
    const disabled = await app.inject({
      method: "POST",
      url: `/v1/packs/${disabledPackId}/open`,
      headers: { authorization: token, "idempotency-key": "disabled-key-0001" },
      payload: { ruleVersion: "pack/v1" }
    });
    expect(disabled.json()).toMatchObject({ ok: false, error: { code: "RESOURCE_CONFLICT" } });
    await app.close();
    database.close();
  });

  it("拒绝余额不足或过期版本，且库存写入失败会回滚扣款、随机审计、开包和事件", async () => {
    const { app, database } = await createTestApp();
    const { activePackId } = seedCatalogAndPacks(database);
    const token = await authorization(app);
    const insufficient = await app.inject({
      method: "POST",
      url: `/v1/packs/${activePackId}/open`,
      headers: { authorization: token, "idempotency-key": "no-archive-key-01" },
      payload: { ruleVersion: "pack/v1" }
    });
    expect(insufficient.json()).toMatchObject({ ok: false, error: { code: "RESOURCE_CONFLICT" } });
    await createArchive(app, token, "archive-key-0002");
    const stale = await app.inject({
      method: "POST",
      url: `/v1/packs/${activePackId}/open`,
      headers: { authorization: token, "idempotency-key": "stale-pack-key-01" },
      payload: { ruleVersion: "pack/v0" }
    });
    expect(stale.json()).toMatchObject({ ok: false, error: { code: "VERSION_STALE" } });
    database
      .prepare(
        "UPDATE booster_pack_rules SET definition_json = replace(definition_json, ?, ?) WHERE pack_id = ?"
      )
      .run(
        "30000000-0000-4000-8000-000000000011",
        "30000000-0000-4000-8000-000000000099",
        activePackId
      );
    const invalid = await app.inject({
      method: "POST",
      url: `/v1/packs/${activePackId}/open`,
      headers: { authorization: token, "idempotency-key": "invalid-pack-key01" },
      payload: { ruleVersion: "pack/v1" }
    });
    expect(invalid.json()).toMatchObject({ ok: false, error: { code: "RULE_VIOLATION" } });
    expect(database.prepare("SELECT total_amount FROM accounts").get()).toEqual({
      total_amount: 10000
    });
    database
      .prepare(
        "UPDATE booster_pack_rules SET definition_json = replace(definition_json, ?, ?) WHERE pack_id = ?"
      )
      .run(
        "30000000-0000-4000-8000-000000000099",
        "30000000-0000-4000-8000-000000000011",
        activePackId
      );
    database
      .prepare(
        "UPDATE accounts SET total_amount = 100, available_amount = 100 WHERE user_id = (SELECT id FROM users WHERE email = 'packs@example.test')"
      )
      .run();
    const lowBalance = await app.inject({
      method: "POST",
      url: `/v1/packs/${activePackId}/open`,
      headers: { authorization: token, "idempotency-key": "low-balance-key-1" },
      payload: { ruleVersion: "pack/v1" }
    });
    expect(lowBalance.json()).toMatchObject({ ok: false, error: { code: "INSUFFICIENT_BALANCE" } });
    database
      .prepare(
        "UPDATE accounts SET total_amount = 10000, available_amount = 10000 WHERE user_id = (SELECT id FROM users WHERE email = 'packs@example.test')"
      )
      .run();
    database.exec(
      "CREATE TRIGGER fail_pack_inventory BEFORE INSERT ON inventory_entries WHEN NEW.reason = 'pack_opened' BEGIN SELECT RAISE(ABORT, 'forced inventory failure'); END"
    );
    const failed = await app.inject({
      method: "POST",
      url: `/v1/packs/${activePackId}/open`,
      headers: { authorization: token, "idempotency-key": "rollback-pack-key1" },
      payload: { ruleVersion: "pack/v1" }
    });
    expect(failed.statusCode).toBe(500);
    expect(database.prepare("SELECT total_amount, available_amount FROM accounts").get()).toEqual({
      total_amount: 10000,
      available_amount: 10000
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM pack_openings").get()).toEqual({
      count: 0
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM pack_rule_replays").get()).toEqual({
      count: 0
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM fact_events").get()).toEqual({
      count: 0
    });
    await app.close();
    database.close();
  });
});
