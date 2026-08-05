import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openSqliteDatabase } from "@mtg-market/database";
import { createApiApp } from "../../app.js";
import { loadApiConfig } from "../../config/environment.js";
import { createTaskRegistry } from "../../task-runner.js";
import {
  ensureDailyRolloverScheduled,
  TaskWorker
} from "../../modules/jobs/application/task-service.js";
import { SqliteJobRepository } from "../../modules/jobs/infrastructure/sqlite-job-repository.js";

/**
 * I32B 发布前后端质量门禁——全局经济对账。
 *
 * 这是一组只读断言，验证发布时余额/账本、库存/库存流水、冻结资金、订单/比赛锁定、
 * 奖励、保证金与事实事件在任何状态下都保持守恒。它不替代任何业务测试，而是把发布
 * 阻断条件收敛为一份可独立运行的恒等式清单：任何一条不平即阻断发布。
 */

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const ids = {
  set: "10000000-0000-4000-8000-000000000321",
  printing: "20000000-0000-4000-8000-000000000321",
  sku: "30000000-0000-4000-8000-000000000321",
  priceRun: "40000000-0000-4000-8000-000000000321",
  priceSnapshot: "50000000-0000-4000-8000-000000000321",
  quote: "60000000-0000-4000-8000-000000000321",
  pack: "70000000-0000-4000-8000-000000000321",
  packRule: "80000000-0000-4000-8000-000000000321"
};

/** 复用 I27B 闭环夹具：可交易 SKU、有效外部快照、游戏报价与可开补充包。 */
function seedReconciliationCatalog(database: Database.Database): void {
  const now = "2026-07-31T00:00:00.000Z";
  database
    .prepare(
      "INSERT INTO card_sets (id, code, name, source, source_reference, created_at) VALUES (?, 'REC', '对账演示系列', 'manual-test', 'I32B fixture', ?)"
    )
    .run(ids.set, now);
  database
    .prepare(
      "INSERT INTO card_printings (id, set_id, name, collector_number, scryfall_id, oracle_id, oracle_text, rarity, legalities_json, color_identity_json, type_line, keywords_json, mana_value, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, '对账赤焰统帅', '1', NULL, 'i32b-red-commander', '', 'rare', '{\"commander\":\"legal\"}', '[\"R\"]', 'Legendary Creature — Human', '[]', 3, 'manual-test', 'I32B fixture', 1, ?, ?)"
    )
    .run(ids.printing, ids.set, now, now);
  database
    .prepare(
      "INSERT INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'nonfoil', 1, 'manual-test', 'I32B fixture', 1, ?, ?)"
    )
    .run(ids.sku, ids.printing, now, now);
  database
    .prepare(
      "INSERT INTO price_sync_runs (id, source, source_version, prices_uri, mapping_uri, prices_checksum_sha256, mapping_checksum_sha256, status, checksum_verification, started_at, completed_at) VALUES (?, 'mtgjson-cardmarket', 'I32B fixture', 'private', 'private', ?, ?, 'succeeded', 'verified', ?, ?)"
    )
    .run(ids.priceRun, "a".repeat(64), "b".repeat(64), now, now);
  database
    .prepare(
      "INSERT INTO price_snapshot_entries (id, sync_run_id, sku_id, mapping_id, mtgjson_uuid, finish, price_type, currency, price_amount, availability, unavailable_reason, captured_at, created_at) VALUES (?, ?, ?, NULL, NULL, 'nonfoil', 'normal', 'EUR', 200, 'priced', NULL, ?, ?)"
    )
    .run(ids.priceSnapshot, ids.priceRun, ids.sku, now, now);
  database
    .prepare(
      "INSERT INTO market_quotes (id, sku_id, price_snapshot_entry_id, trigger_key, rule_version, reference_price_eur_cents, market_price_amount, npc_buy_price_amount, npc_sell_price_amount, npc_buy_fee_amount, npc_sell_fee_amount, parameters_json, reasons_json, calculated_at, valid_until) VALUES (?, ?, ?, 'I32B fixture', 'market/v1', 200, 200, 170, 250, 20, 25, '{}', '[]', ?, '2099-01-01T00:00:00.000Z')"
    )
    .run(ids.quote, ids.sku, ids.priceSnapshot, now);
  const definition = JSON.stringify({
    version: "pack/v1",
    pools: [{ id: "commander", rarity: "rare", candidates: [{ skuId: ids.sku, weight: 1 }] }],
    slots: [{ id: "guaranteed-commander", draws: 2, poolWeights: [{ poolId: "commander", weight: 1 }] }]
  });
  database
    .prepare(
      "INSERT INTO booster_packs (id, code, name, description, price_amount, enabled, disabled_reason, active_rule_version, created_at, updated_at) VALUES (?, 'REC-01', '对账演示补充包', 'I32B 可重复发布门禁夹具', 500, 1, NULL, 'pack/v1', ?, ?)"
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

/**
 * 全局经济对账：跨越所有账户/库存/锁定/奖励/事实事件的只读恒等式断言。
 * 任何一条不平即视为发布阻断。本函数刻意覆盖全局表（不限定 userId），保证
 * 包括系统/NPC 侧在内的所有经济行都满足不变量。
 */
function reconcileGlobalEconomy(database: Database.Database): void {
  // 1. 账户恒等式：total = available + frozen；total = 账本净额（credit - debit）。
  const accounts = database
    .prepare(
      "SELECT a.id, a.user_id, a.total_amount, a.available_amount, a.frozen_amount, COALESCE(SUM(CASE WHEN e.direction = 'credit' THEN e.amount ELSE -e.amount END), 0) AS ledger_net FROM accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id GROUP BY a.id ORDER BY a.id"
    )
    .all() as Array<{
    id: string;
    total_amount: number;
    available_amount: number;
    frozen_amount: number;
    ledger_net: number;
  }>;
  expect(accounts.length).toBeGreaterThan(0);
  for (const account of accounts) {
    expect(account.total_amount).toBe(account.available_amount + account.frozen_amount);
    expect(account.total_amount).toBe(account.ledger_net);
  }

  // 2. 账本 balance_after 单调性：按账户、按写入顺序（occurred_at 相同则按插入序 rowid）重放
  //    credit/debit 必须严格等于 balance_after。I35B 起同一经济事务可能为同一账户写多条账本
  //    （如开包消费与等级升级奖励同 occurred_at），故必须以插入序（rowid）重放而非随机 id。
  const entriesByAccount = database
    .prepare(
      "SELECT account_id, direction, amount, balance_after FROM ledger_entries ORDER BY account_id, occurred_at, rowid"
    )
    .all() as Array<{ account_id: string; direction: string; amount: number; balance_after: number }>;
  const running = new Map<string, number>();
  for (const entry of entriesByAccount) {
    const next = (running.get(entry.account_id) ?? 0) + (entry.direction === "credit" ? entry.amount : -entry.amount);
    expect(entry.balance_after).toBe(next);
    expect(entry.balance_after).toBeGreaterThanOrEqual(0);
    running.set(entry.account_id, next);
  }

  // 3. 库存恒等式：quantity = entry 净额；quantity = available + order_locked + tournament_locked。
  const holdings = database
    .prepare(
      "SELECT h.id, h.quantity, h.available_quantity, h.order_locked_quantity, h.tournament_locked_quantity, COALESCE(SUM(e.quantity_delta), 0) AS entry_net FROM inventory_holdings h LEFT JOIN inventory_entries e ON e.holding_id = h.id GROUP BY h.id ORDER BY h.id"
    )
    .all() as Array<{
    id: string;
    quantity: number;
    available_quantity: number;
    order_locked_quantity: number;
    tournament_locked_quantity: number;
    entry_net: number;
  }>;
  for (const holding of holdings) {
    expect(holding.quantity).toBe(holding.entry_net);
    expect(holding.quantity).toBe(
      holding.available_quantity + holding.order_locked_quantity + holding.tournament_locked_quantity
    );
  }

  // 4. 冻结额守恒：每账户 frozen_amount = 该账户所有 active fund_holds 金额合计。
  const frozenReconciliation = database
    .prepare(
      "SELECT a.id, a.frozen_amount, COALESCE(SUM(h.amount), 0) AS active_holds_total FROM accounts a LEFT JOIN fund_holds h ON h.account_id = a.id AND h.status = 'active' GROUP BY a.id HAVING a.frozen_amount <> active_holds_total"
    )
    .all() as Array<{ id: string }>;
  expect(frozenReconciliation).toEqual([]);

  // 5. 库存锁定守恒：每个 holding 的 order_locked + tournament_locked = 该 holding 所有 active
  //    inventory_holds 数量合计（按 reason 分桶可进一步区分，此处断言总量守恒）。
  const lockedReconciliation = database
    .prepare(
      "SELECT h.id, (h.order_locked_quantity + h.tournament_locked_quantity) AS locked_total, COALESCE(SUM(ih.quantity), 0) AS active_holds_total FROM inventory_holdings h LEFT JOIN inventory_holds ih ON ih.holding_id = h.id AND ih.status = 'active' GROUP BY h.id HAVING locked_total <> active_holds_total"
    )
    .all() as Array<{ id: string }>;
  expect(lockedReconciliation).toEqual([]);

  // 6. hold 引用闭包：bilateral_orders.reserved_funds_hold_id 与 bilateral_trades 的三个 hold
  //    引用必须指向存在的 hold 行；成交终态时其 hold 不应为 active（已 released/captured）。
  const orderFundHoldGaps = database
    .prepare(
      "SELECT o.id FROM bilateral_orders o LEFT JOIN fund_holds h ON h.id = o.reserved_funds_hold_id WHERE o.reserved_funds_hold_id IS NOT NULL AND h.id IS NULL"
    )
    .all() as Array<{ id: string }>;
  expect(orderFundHoldGaps).toEqual([]);
  const tradeActiveOnTerminal = database
    .prepare(
      "SELECT t.id, t.status FROM bilateral_trades t LEFT JOIN fund_holds bf ON bf.id = t.buyer_funds_hold_id LEFT JOIN fund_holds df ON df.id = t.seller_deposit_hold_id LEFT JOIN inventory_holds si ON si.id = t.seller_inventory_hold_id WHERE t.status IN ('fulfilled','cancelled') AND (bf.status = 'active' OR df.status = 'active' OR si.status = 'active')"
    )
    .all() as Array<{ id: string; status: string }>;
  expect(tradeActiveOnTerminal).toEqual([]);

  // 7. 事实事件与 outbox 一致：每条 outbox 必须指向存在的 fact_event；p2p.trade.settled 只
  //    能由 fulfilled 成交产生（取消/到期不得有）。
  const orphanOutbox = database
    .prepare("SELECT o.id FROM outbox o LEFT JOIN fact_events f ON f.id = o.event_id WHERE f.id IS NULL")
    .all() as Array<{ id: string }>;
  expect(orphanOutbox).toEqual([]);
  const p2pSettledWithoutFulfilled = database
    .prepare(
      "SELECT f.id FROM fact_events f LEFT JOIN bilateral_trades t ON t.id = f.aggregate_id WHERE f.event_type = 'p2p.trade.settled' AND t.status <> 'fulfilled'"
    )
    .all() as Array<{ id: string }>;
  expect(p2pSettledWithoutFulfilled).toEqual([]);

  // 8. 奖励可追溯性：每笔 GAME_CREDIT 奖励（赛事/成就）必须能经 correlation_id 反查到
  //    对应 reason 的账本流水——奖励不可脱离账本凭空入账。
  const tournamentCreditRewards = database
    .prepare(
      "SELECT r.registration_id, r.amount FROM tournament_rewards r WHERE r.reason = 'pool_game_credit' AND r.amount > 0"
    )
    .all() as Array<{ registration_id: string; amount: number }>;
  for (const reward of tournamentCreditRewards) {
    const matched = database
      .prepare(
        "SELECT COUNT(*) AS count FROM ledger_entries WHERE correlation_id = ? AND reason = 'tournament_reward'"
      )
      .get(`tournament-reward:${reward.registration_id}`) as { count: number };
    expect(matched.count).toBe(1);
  }
  const playerTournamentCreditRewards = database
    .prepare(
      "SELECT r.registration_id, r.amount FROM player_tournament_rewards r WHERE r.reason = 'pool_game_credit' AND r.amount > 0"
    )
    .all() as Array<{ registration_id: string; amount: number }>;
  for (const reward of playerTournamentCreditRewards) {
    const matched = database
      .prepare(
        "SELECT COUNT(*) AS count FROM ledger_entries WHERE correlation_id = ? AND reason = 'tournament_reward'"
      )
      .get(`player-tournament-reward:${reward.registration_id}`) as { count: number };
    expect(matched.count).toBe(1);
  }
  const grantedAchievementCredits = database
    .prepare(
      "SELECT g.id, g.correlation_id FROM achievement_reward_grants g WHERE g.grant_status = 'granted' AND g.reward_kind = 'GAME_CREDIT' AND g.reward_amount > 0"
    )
    .all() as Array<{ id: string; correlation_id: string }>;
  for (const grant of grantedAchievementCredits) {
    const matched = database
      .prepare(
        "SELECT COUNT(*) AS count FROM ledger_entries WHERE correlation_id = ? AND reason = 'achievement_reward'"
      )
      .get(grant.correlation_id) as { count: number };
    expect(matched.count).toBe(1);
  }
}

async function buildReconciliationApp(): Promise<{
  app: Awaited<ReturnType<typeof createApiApp>>;
  database: Database.Database;
  worker: TaskWorker;
  clock: Date;
}> {
  const directory = mkdtempSync(join(tmpdir(), "mtg-i32b-recon-"));
  directories.push(directory);
  const databasePath = join(directory, "recon.db");
  const database = openSqliteDatabase(databasePath);
  const config = loadApiConfig({
    APP_ENV: "test",
    SQLITE_PATH: databasePath,
    AUTH_JWT_SECRET: "test-only-secret-must-be-at-least-32-characters",
    LEYLINE_ENDPOINT: "https://leyline.i32b.test/evaluate",
    LEYLINE_MAX_RETRIES: "0"
  });
  const app = await createApiApp(config, database);
  seedReconciliationCatalog(database);
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
  return { app, database, worker, clock };
}

describe("I32B 全局经济对账发布门禁", () => {
  it("终态闭环：开包、NPC、P2P、比赛、成就、再投资后全局恒等式成立", async () => {
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
    const { app, database, worker, clock } = await buildReconciliationApp();

    expect(await worker.runOne()).toBe(true); // daily.rollover 打开工作资金资格

    const alice = await registerPlayer(app, "i32b-alice@example.test", "对账玩家 A");
    const bob = await registerPlayer(app, "i32b-bob@example.test", "对账玩家 B");
    await createArchive(app, alice.authorization, "i32b-alice-archive-0001");
    await createArchive(app, bob.authorization, "i32b-bob-archive-0001");

    // 领取工作资金、开包、NPC 买卖，制造混合经济活动。
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/daily-work-funding/claim",
          headers: { authorization: alice.authorization, "idempotency-key": "i32b-funding-0001" },
          payload: {}
        })
      ).statusCode
    ).toBe(201);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/packs/${ids.pack}/open`,
          headers: { authorization: alice.authorization, "idempotency-key": "i32b-pack-0001" },
          payload: { ruleVersion: "pack/v1" }
        })
      ).statusCode
    ).toBe(201);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/npc-trades/buy/${ids.sku}`,
          headers: { authorization: alice.authorization, "idempotency-key": "i32b-npc-buy-0001" },
          payload: { quoteId: ids.quote, quoteVersion: "market/v1", quantity: 1, maxUnitPrice: 250 }
        })
      ).statusCode
    ).toBe(201);

    // P2P：bob 买单、alice 卖单 → 撮合 → 履约，制造资金/库存/保证金全流转。
    const buyPreview = await app.inject({
      method: "GET",
      url: `/v1/orders/buy/${ids.sku}/preview?quantity=1`,
      headers: { authorization: bob.authorization }
    });
    const buyOrder = await app.inject({
      method: "POST",
      url: `/v1/orders/buy/${ids.sku}`,
      headers: { authorization: bob.authorization, "idempotency-key": "i32b-p2p-buy-0001" },
      payload: {
        quoteId: ids.quote,
        quoteVersion: "market/v1",
        previewVersion: buyPreview.json().data.preview.previewVersion,
        quantity: 1,
        limitPrice: 200
      }
    });
    const sellPreview = await app.inject({
      method: "GET",
      url: `/v1/orders/sell/${ids.sku}/preview?quantity=1`,
      headers: { authorization: alice.authorization }
    });
    const sellOrder = await app.inject({
      method: "POST",
      url: `/v1/orders/sell/${ids.sku}`,
      headers: { authorization: alice.authorization, "idempotency-key": "i32b-p2p-sell-0001" },
      payload: {
        quoteId: ids.quote,
        quoteVersion: "market/v1",
        previewVersion: sellPreview.json().data.preview.previewVersion,
        quantity: 1,
        limitPrice: 200
      }
    });
    expect(buyOrder.statusCode).toBe(201);
    expect(sellOrder.statusCode).toBe(201);

    const trades = await app.inject({
      method: "GET",
      url: "/v1/orders/trades",
      headers: { authorization: alice.authorization }
    });
    const trade = trades.json().data.items[0] as { id: string };
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/orders/trades/${trade.id}/fulfill`,
          headers: { authorization: alice.authorization, "idempotency-key": "i32b-fulfill-0001" },
          payload: {}
        })
      ).statusCode
    ).toBe(200);

    // 构筑、报名、结算赛事，制造比赛锁定释放与奖励/成就流水。
    const deck = await app.inject({
      method: "POST",
      url: "/v1/decks",
      headers: { authorization: alice.authorization, "idempotency-key": "i32b-deck-0001" },
      payload: {
        name: "对账赤焰 Commander",
        cards: [
          { zone: "commander", skuId: ids.sku, quantity: 1 },
          { zone: "virtual_basic", virtualBasic: "mountain", quantity: 99 }
        ]
      }
    });
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
      headers: { authorization: alice.authorization, "idempotency-key": "i32b-register-0001" },
      payload: { deckId: deck.json().data.id }
    });
    expect(registration.statusCode).toBe(201);

    // 只让本链路结算/成就任务进入 worker。
    database
      .prepare(
        "UPDATE jobs SET status = 'succeeded', updated_at = ? WHERE type NOT IN ('tournament.settle', 'achievement.process') AND status IN ('pending', 'failed')"
      )
      .run(clock.toISOString());
    expect(await worker.runOne()).toBe(true);
    expect(await worker.runOne()).toBe(true);

    // 再投资开包，确保闭环可重复进入。
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/packs/${ids.pack}/open`,
          headers: { authorization: alice.authorization, "idempotency-key": "i32b-reinvest-0001" },
          payload: { ruleVersion: "pack/v1" }
        })
      ).statusCode
    ).toBe(201);

    // 终态：所有比赛/订单 hold 应已释放；全局恒等式必须成立。
    expect(
      (database.prepare("SELECT COUNT(*) AS count FROM fund_holds WHERE status = 'active'").get() as {
        count: number;
      }).count
    ).toBe(0);
    expect(
      (database.prepare("SELECT COUNT(*) AS count FROM inventory_holds WHERE status = 'active'").get() as {
        count: number;
      }).count
    ).toBe(0);

    reconcileGlobalEconomy(database);

    await app.close();
    database.close();
  });

  it("活跃锁定中间态：买单资金冻结与卖单库存锁定并存时守恒等式仍成立（非终态巧合平衡）", async () => {
    const { app, database, worker } = await buildReconciliationApp();
    expect(await worker.runOne()).toBe(true);

    const alice = await registerPlayer(app, "i32b-mid-alice@example.test", "中间态玩家 A");
    const bob = await registerPlayer(app, "i32b-mid-bob@example.test", "中间态玩家 B");
    await createArchive(app, alice.authorization, "i32b-mid-alice-archive-0001");
    await createArchive(app, bob.authorization, "i32b-mid-bob-archive-0001");

    // 领资金、开包（alice 持卡可供卖单锁定）。
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/daily-work-funding/claim",
          headers: { authorization: alice.authorization, "idempotency-key": "i32b-mid-fund-0001" },
          payload: {}
        })
      ).statusCode
    ).toBe(201);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/packs/${ids.pack}/open`,
          headers: { authorization: alice.authorization, "idempotency-key": "i32b-mid-pack-0001" },
          payload: { ruleVersion: "pack/v1" }
        })
      ).statusCode
    ).toBe(201);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/daily-work-funding/claim",
          headers: { authorization: bob.authorization, "idempotency-key": "i32b-mid-fund-0002" },
          payload: {}
        })
      ).statusCode
    ).toBe(201);

    // 故意停在活跃锁定中间态：买单冻结 bob 资金，卖单锁定 alice 库存，不撮合、不履约。
    const buyPreview = await app.inject({
      method: "GET",
      url: `/v1/orders/buy/${ids.sku}/preview?quantity=1`,
      headers: { authorization: bob.authorization }
    });
    const buyOrder = await app.inject({
      method: "POST",
      url: `/v1/orders/buy/${ids.sku}`,
      headers: { authorization: bob.authorization, "idempotency-key": "i32b-mid-buy-0001" },
      payload: {
        quoteId: ids.quote,
        quoteVersion: "market/v1",
        previewVersion: buyPreview.json().data.preview.previewVersion,
        quantity: 1,
        limitPrice: 200
      }
    });
    const sellPreview = await app.inject({
      method: "GET",
      url: `/v1/orders/sell/${ids.sku}/preview?quantity=1`,
      headers: { authorization: alice.authorization }
    });
    const sellOrder = await app.inject({
      method: "POST",
      url: `/v1/orders/sell/${ids.sku}`,
      headers: { authorization: alice.authorization, "idempotency-key": "i32b-mid-sell-0001" },
      payload: {
        quoteId: ids.quote,
        quoteVersion: "market/v1",
        previewVersion: sellPreview.json().data.preview.previewVersion,
        quantity: 1,
        limitPrice: 200
      }
    });
    expect(buyOrder.statusCode).toBe(201);
    expect(sellOrder.statusCode).toBe(201);

    // 订单创建成功后会自动撮合（I19B：创建成功即触发撮合），故中间态真实形态是一笔
    // matched_pending_fulfillment 成交：买方资金、卖方库存与保证金已从「预占 active」转为
    // 「待履约 captured/released」，但尚未履约结算（未写 p2p.trade.settled、未转最终所有权）。
    // 这正是发布前必须对账的非终态场景：守恒等式在待履约中间态下也必须成立。
    const tradesMid = database
      .prepare("SELECT status FROM bilateral_trades")
      .all() as Array<{ status: string }>;
    expect(tradesMid.length).toBeGreaterThan(0);
    expect(tradesMid.every((t) => t.status === "matched_pending_fulfillment")).toBe(true);
    // 确认确实尚未写 p2p.trade.settled（未到履约结算阶段）。
    expect(
      (
        database
          .prepare("SELECT COUNT(*) AS count FROM fact_events WHERE event_type = 'p2p.trade.settled'")
          .get() as { count: number }
      ).count
    ).toBe(0);

    // 即使存在待履约资产（已 captured 的资金/库存/保证金），全部守恒等式仍必须成立——
    // 这排除了“终态巧合平衡”。
    reconcileGlobalEconomy(database);

    await app.close();
    database.close();
  });
});
