import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openSqliteDatabase } from "@mtg-market/database";
import { createApiApp } from "../../app.js";
import { loadApiConfig } from "../../config/environment.js";
import { createTaskRegistry } from "../../task-runner.js";
import {
  ensureDailyRolloverScheduled,
  TaskWorker
} from "../../modules/jobs/application/task-service.js";
import { SqliteJobRepository } from "../../modules/jobs/infrastructure/sqlite-job-repository.js";

const directories: string[] = [];
const ids = {
  set: "10000000-0000-4000-8000-000000000271",
  printing: "20000000-0000-4000-8000-000000000271",
  sku: "30000000-0000-4000-8000-000000000271",
  priceRun: "40000000-0000-4000-8000-000000000271",
  priceSnapshot: "50000000-0000-4000-8000-000000000271",
  quote: "60000000-0000-4000-8000-000000000271",
  pack: "70000000-0000-4000-8000-000000000271",
  packRule: "80000000-0000-4000-8000-000000000271"
};

afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function seedLoopCatalog(database: ReturnType<typeof openSqliteDatabase>): void {
  const now = "2026-07-30T00:00:00.000Z";
  database
    .prepare(
      "INSERT INTO card_sets (id, code, name, source, source_reference, created_at) VALUES (?, 'LOOP', '闭环演示系列', 'manual-test', 'I27B fixture', ?)"
    )
    .run(ids.set, now);
  database
    .prepare(
      "INSERT INTO card_printings (id, set_id, name, collector_number, scryfall_id, oracle_id, oracle_text, rarity, legalities_json, color_identity_json, type_line, keywords_json, mana_value, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, '闭环赤焰统帅', '1', NULL, 'i27b-red-commander', '', 'rare', '{\"commander\":\"legal\"}', '[\"R\"]', 'Legendary Creature — Human', '[]', 3, 'manual-test', 'I27B fixture', 1, ?, ?)"
    )
    .run(ids.printing, ids.set, now, now);
  database
    .prepare(
      "INSERT INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'nonfoil', 1, 'manual-test', 'I27B fixture', 1, ?, ?)"
    )
    .run(ids.sku, ids.printing, now, now);
  database
    .prepare(
      "INSERT INTO price_sync_runs (id, source, source_version, prices_uri, mapping_uri, prices_checksum_sha256, mapping_checksum_sha256, status, checksum_verification, started_at, completed_at) VALUES (?, 'mtgjson-cardmarket', 'I27B fixture', 'private', 'private', ?, ?, 'succeeded', 'verified', ?, ?)"
    )
    .run(ids.priceRun, "a".repeat(64), "b".repeat(64), now, now);
  database
    .prepare(
      "INSERT INTO price_snapshot_entries (id, sync_run_id, sku_id, mapping_id, mtgjson_uuid, finish, price_type, currency, price_amount, availability, unavailable_reason, captured_at, created_at) VALUES (?, ?, ?, NULL, NULL, 'nonfoil', 'normal', 'EUR', 200, 'priced', NULL, ?, ?)"
    )
    .run(ids.priceSnapshot, ids.priceRun, ids.sku, now, now);
  database
    .prepare(
      "INSERT INTO market_quotes (id, sku_id, price_snapshot_entry_id, trigger_key, rule_version, reference_price_eur_cents, market_price_amount, npc_buy_price_amount, npc_sell_price_amount, npc_buy_fee_amount, npc_sell_fee_amount, parameters_json, reasons_json, calculated_at, valid_until) VALUES (?, ?, ?, 'I27B fixture', 'market/v1', 200, 200, 170, 250, 20, 25, '{}', '[]', ?, '2099-01-01T00:00:00.000Z')"
    )
    .run(ids.quote, ids.sku, ids.priceSnapshot, now);
  const definition = JSON.stringify({
    version: "pack/v1",
    pools: [{ id: "commander", rarity: "rare", candidates: [{ skuId: ids.sku, weight: 1 }] }],
    slots: [
      { id: "guaranteed-commander", draws: 2, poolWeights: [{ poolId: "commander", weight: 1 }] }
    ]
  });
  database
    .prepare(
      "INSERT INTO booster_packs (id, code, name, description, price_amount, enabled, disabled_reason, active_rule_version, created_at, updated_at) VALUES (?, 'LOOP-01', '闭环演示补充包', 'I27B 可重复服务端验收夹具', 500, 1, NULL, 'pack/v1', ?, ?)"
    )
    .run(ids.pack, now, now);
  database
    .prepare(
      "INSERT INTO booster_pack_rules (id, pack_id, version, definition_json, created_at, retired_at) VALUES (?, ?, 'pack/v1', ?, ?, NULL)"
    )
    .run(ids.packRule, ids.pack, definition, now);
}

async function registerPlayer(
  app: Awaited<ReturnType<typeof createApiApp>>,
  email: string,
  displayName: string
) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    payload: { email, displayName, password: "correct-horse-battery-staple" }
  });
  expect(response.statusCode).toBe(201);
  return {
    authorization: `Bearer ${response.json().data.accessToken as string}`,
    userId: response.json().data.user.id as string
  };
}

async function createArchive(
  app: Awaited<ReturnType<typeof createApiApp>>,
  authorization: string,
  key: string
): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/archive",
    headers: { authorization, "idempotency-key": key },
    payload: {}
  });
  expect(response.statusCode).toBe(201);
}

function orderBody(preview: { previewVersion: string }, quantity: number) {
  return {
    quoteId: ids.quote,
    quoteVersion: "market/v1",
    previewVersion: preview.previewVersion,
    quantity,
    limitPrice: 200
  };
}

/** I27B 的最终对账：余额必须等于账本净额，资金冻结与库存锁定必须逐项守恒。 */
function expectEconomicReconciliation(
  database: ReturnType<typeof openSqliteDatabase>,
  userIds: string[]
): void {
  const accounts = database
    .prepare(
      "SELECT a.user_id, a.total_amount, a.available_amount, a.frozen_amount, COALESCE(SUM(CASE WHEN e.direction = 'credit' THEN e.amount ELSE -e.amount END), 0) AS ledger_net FROM accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id WHERE a.user_id IN (?, ?) GROUP BY a.id ORDER BY a.user_id"
    )
    .all(...userIds) as Array<{
    user_id: string;
    total_amount: number;
    available_amount: number;
    frozen_amount: number;
    ledger_net: number;
  }>;
  expect(accounts).toHaveLength(2);
  for (const account of accounts) {
    expect(account.total_amount).toBe(account.ledger_net);
    expect(account.total_amount).toBe(account.available_amount + account.frozen_amount);
  }

  const inventory = database
    .prepare(
      "SELECT h.id, h.quantity, h.available_quantity, h.order_locked_quantity, h.tournament_locked_quantity, COALESCE(SUM(e.quantity_delta), 0) AS entry_net FROM inventory_holdings h LEFT JOIN inventory_entries e ON e.holding_id = h.id WHERE h.user_id IN (?, ?) GROUP BY h.id ORDER BY h.id"
    )
    .all(...userIds) as Array<{
    quantity: number;
    available_quantity: number;
    order_locked_quantity: number;
    tournament_locked_quantity: number;
    entry_net: number;
  }>;
  expect(inventory.length).toBeGreaterThan(0);
  for (const holding of inventory) {
    expect(holding.quantity).toBe(holding.entry_net);
    expect(holding.quantity).toBe(
      holding.available_quantity +
        holding.order_locked_quantity +
        holding.tournament_locked_quantity
    );
  }

  expect(
    database.prepare("SELECT COUNT(*) AS count FROM fund_holds WHERE status = 'active'").get()
  ).toEqual({ count: 0 });
  expect(
    database.prepare("SELECT COUNT(*) AS count FROM inventory_holds WHERE status = 'active'").get()
  ).toEqual({ count: 0 });
}

describe("I27B 服务端玩家经济闭环", () => {
  it("以可重复 SQLite 夹具串联工作资金、开包、NPC/P2P、构筑、赛事、成就和再投资，并完成对账", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ scores: { power: 72 }, bracket: 2, missingCards: null }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
      )
    );
    const directory = mkdtempSync(join(tmpdir(), "mtg-i27b-loop-"));
    directories.push(directory);
    const databasePath = join(directory, "loop.db");
    const database = openSqliteDatabase(databasePath);
    const config = loadApiConfig({
      APP_ENV: "test",
      SQLITE_PATH: databasePath,
      AUTH_JWT_SECRET: "test-only-secret-must-be-at-least-32-characters",
      LEYLINE_ENDPOINT: "https://leyline.i27b.test/evaluate",
      LEYLINE_MAX_RETRIES: "0"
    });
    const app = await createApiApp(config, database);
    seedLoopCatalog(database);

    // 先执行日切任务；领取 API 只消费由服务端任务打开的资格，绝不以浏览器日期判断。
    const clock = new Date(Date.now() + 1_000);
    ensureDailyRolloverScheduled(
      database,
      { timezone: config.APP_TIMEZONE, ruleVersion: config.DAILY_WORK_FUNDING_RULE_VERSION },
      clock
    );
    const worker = new TaskWorker(
      new SqliteJobRepository(database),
      createTaskRegistry(config, database),
      () => clock
    );
    expect(await worker.runOne()).toBe(true);

    const alice = await registerPlayer(app, "i27b-alice@example.test", "闭环玩家 A");
    const bob = await registerPlayer(app, "i27b-bob@example.test", "闭环玩家 B");
    await createArchive(app, alice.authorization, "i27b-alice-archive-0001");
    await createArchive(app, bob.authorization, "i27b-bob-archive-0001");

    const funding = await app.inject({
      method: "POST",
      url: "/v1/daily-work-funding/claim",
      headers: { authorization: alice.authorization, "idempotency-key": "i27b-alice-funding-0001" },
      payload: {}
    });
    expect(funding.statusCode).toBe(201);
    expect(funding.json()).toMatchObject({
      ok: true,
      data: {
        funding: { ruleVersion: "daily-work-funds/v1", amount: { amount: expect.any(Number) } }
      }
    });

    const firstPack = await app.inject({
      method: "POST",
      url: `/v1/packs/${ids.pack}/open`,
      headers: { authorization: alice.authorization, "idempotency-key": "i27b-first-pack-0001" },
      payload: { ruleVersion: "pack/v1" }
    });
    expect(firstPack.statusCode).toBe(201);
    expect(firstPack.json().data.opening.received).toEqual([
      expect.objectContaining({ skuId: ids.sku, quantity: 2, cost: expect.any(Object) })
    ]);

    const npcBuy = await app.inject({
      method: "POST",
      url: `/v1/npc-trades/buy/${ids.sku}`,
      headers: { authorization: alice.authorization, "idempotency-key": "i27b-npc-buy-0001" },
      payload: { quoteId: ids.quote, quoteVersion: "market/v1", quantity: 1, maxUnitPrice: 250 }
    });
    const npcSell = await app.inject({
      method: "POST",
      url: `/v1/npc-trades/sell/${ids.sku}`,
      headers: { authorization: alice.authorization, "idempotency-key": "i27b-npc-sell-0001" },
      payload: { quoteId: ids.quote, quoteVersion: "market/v1", quantity: 1, minUnitPrice: 170 }
    });
    expect(npcBuy.statusCode).toBe(201);
    expect(npcSell.statusCode).toBe(201);

    const buyPreview = await app.inject({
      method: "GET",
      url: `/v1/orders/buy/${ids.sku}/preview?quantity=1`,
      headers: { authorization: bob.authorization }
    });
    const buyOrder = await app.inject({
      method: "POST",
      url: `/v1/orders/buy/${ids.sku}`,
      headers: { authorization: bob.authorization, "idempotency-key": "i27b-p2p-buy-0001" },
      payload: orderBody(buyPreview.json().data.preview, 1)
    });
    const sellPreview = await app.inject({
      method: "GET",
      url: `/v1/orders/sell/${ids.sku}/preview?quantity=1`,
      headers: { authorization: alice.authorization }
    });
    const sellOrder = await app.inject({
      method: "POST",
      url: `/v1/orders/sell/${ids.sku}`,
      headers: { authorization: alice.authorization, "idempotency-key": "i27b-p2p-sell-0001" },
      payload: orderBody(sellPreview.json().data.preview, 1)
    });
    expect(buyOrder.statusCode).toBe(201);
    expect(sellOrder.statusCode).toBe(201);

    const trades = await app.inject({
      method: "GET",
      url: "/v1/orders/trades",
      headers: { authorization: alice.authorization }
    });
    const trade = trades.json().data.items[0] as { id: string; status: string; role: string };
    expect(trade).toMatchObject({ status: "matched_pending_fulfillment", role: "seller" });
    const fulfilled = await app.inject({
      method: "POST",
      url: `/v1/orders/trades/${trade.id}/fulfill`,
      headers: { authorization: alice.authorization, "idempotency-key": "i27b-p2p-fulfill-0001" },
      payload: {}
    });
    expect(fulfilled.statusCode).toBe(200);
    expect(fulfilled.json()).toMatchObject({
      ok: true,
      data: { trade: { id: trade.id, status: "fulfilled" } }
    });

    const deck = await app.inject({
      method: "POST",
      url: "/v1/decks",
      headers: { authorization: alice.authorization, "idempotency-key": "i27b-deck-0001" },
      payload: {
        name: "闭环赤焰 Commander",
        cards: [
          { zone: "commander", skuId: ids.sku, quantity: 1 },
          { zone: "virtual_basic", virtualBasic: "mountain", quantity: 99 }
        ]
      }
    });
    expect(deck.statusCode).toBe(201);
    expect(deck.json()).toMatchObject({ data: { legality: { valid: true, totalCards: 100 } } });

    const tournaments = await app.inject({
      method: "GET",
      url: "/v1/tournaments",
      headers: { authorization: alice.authorization }
    });
    const tournamentId = (
      tournaments.json().data.items as Array<{ id: string; templateId: string }>
    ).find((item) => item.templateId === "daily-npc-single/v1")!.id;
    const registration = await app.inject({
      method: "POST",
      url: `/v1/tournaments/${tournamentId}/register`,
      headers: {
        authorization: alice.authorization,
        "idempotency-key": "i27b-tournament-register-0001"
      },
      payload: { deckId: deck.json().data.id }
    });
    expect(registration.statusCode).toBe(201);
    const registrationId = registration.json().data.registration.id as string;

    // 只让本链路产生的结算/成就任务进入 worker，先前事实触发的重定价任务不属于该验收的结算断言。
    database
      .prepare(
        "UPDATE jobs SET status = 'succeeded', updated_at = ? WHERE type NOT IN ('tournament.settle', 'achievement.process') AND status IN ('pending', 'failed')"
      )
      .run(clock.toISOString());
    expect(await worker.runOne()).toBe(true);
    expect(await worker.runOne()).toBe(true);
    expect(
      database
        .prepare("SELECT status FROM tournament_registrations WHERE id = ?")
        .get(registrationId)
    ).toEqual({ status: "settled" });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM fact_events WHERE aggregate_id = ? AND event_type = 'tournament.settled'"
        )
        .get(registrationId)
    ).toEqual({ count: 1 });

    const achievements = await app.inject({
      method: "GET",
      url: "/v1/achievements/unlocks",
      headers: { authorization: alice.authorization }
    });
    expect(achievements.json().data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          definitionId: "first-tournament/v1",
          rewardStatus: "granted",
          source: expect.objectContaining({
            type: "tournament.settled",
            aggregateId: registrationId
          })
        })
      ])
    );

    const reinvestment = await app.inject({
      method: "POST",
      url: `/v1/packs/${ids.pack}/open`,
      headers: {
        authorization: alice.authorization,
        "idempotency-key": "i27b-reinvestment-pack-0001"
      },
      payload: { ruleVersion: "pack/v1" }
    });
    expect(reinvestment.statusCode).toBe(201);
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM pack_openings WHERE user_id = ?")
        .get(alice.userId)
    ).toEqual({ count: 2 });

    expectEconomicReconciliation(database, [alice.userId, bob.userId]);
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM fact_events WHERE event_type IN ('pack.opened', 'npc.trade.settled', 'p2p.trade.settled', 'tournament.settled')"
        )
        .get()
    ).toEqual({ count: 6 });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_logs WHERE actor_id = ? AND action = 'bilateral_trade.fulfilled'"
        )
        .get(alice.userId)
    ).toEqual({ count: 1 });
    expect(
      (
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM audit_logs WHERE actor_id = ? AND action = 'achievement.unlocked'"
          )
          .get(alice.userId) as { count: number }
      ).count
    ).toBeGreaterThan(0);

    await app.close();
    database.close();
  });
});
