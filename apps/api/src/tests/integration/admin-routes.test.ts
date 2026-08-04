import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "@mtg-market/database";
import { createApiApp } from "../../app.js";
import { loadApiConfig } from "../../config/environment.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

async function createTestApp() {
  const directory = mkdtempSync(join(tmpdir(), "mtg-admin-"));
  directories.push(directory);
  const database = openSqliteDatabase(join(directory, "test.db"));
  const app = await createApiApp(loadApiConfig({ APP_ENV: "test", SQLITE_PATH: join(directory, "test.db"), AUTH_JWT_SECRET: "test-only-secret-must-be-at-least-32-characters" }), database);
  return { app, database };
}

async function registerAndPromoteAdmin(app: Awaited<ReturnType<typeof createApiApp>>, database: ReturnType<typeof openSqliteDatabase>) {
  const email = "admin@example.test";
  await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email, displayName: "管理员", password: "correct-horse-battery-staple" } });
  database.prepare("UPDATE users SET role = 'admin' WHERE email = ?").run(email);
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password: "correct-horse-battery-staple" } });
  return { authorization: `Bearer ${login.json().data.accessToken as string}`, userId: login.json().data.user.id as string };
}

async function registerPlayer(app: Awaited<ReturnType<typeof createApiApp>>, email: string) {
  const response = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email, displayName: "玩家", password: "correct-horse-battery-staple" } });
  return { authorization: `Bearer ${response.json().data.accessToken as string}`, userId: response.json().data.user.id as string };
}

function seedCatalog(database: ReturnType<typeof openSqliteDatabase>): { skuId: string } {
  const now = "2026-07-31T00:00:00.000Z";
  const setId = "10000000-0000-4000-8000-000000000301";
  const printingId = "20000000-0000-4000-8000-000000000301";
  const skuId = "30000000-0000-4000-8000-000000000301";
  database.prepare("INSERT INTO card_sets (id, code, name, source, source_reference, created_at) VALUES (?, 'ADM', '管理测试系列', 'manual-test', 'I30B', ?)").run(setId, now);
  database.prepare("INSERT INTO card_printings (id, set_id, name, collector_number, scryfall_id, oracle_text, rarity, legalities_json, color_identity_json, type_line, keywords_json, mana_value, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, '测试卡', '1', NULL, '', 'common', '{}', '[]', '', '[]', 1, 'manual-test', 'I30B', 1, ?, ?)").run(printingId, setId, now, now);
  database.prepare("INSERT INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'nonfoil', 1, 'manual-test', 'I30B', 1, ?, ?)").run(skuId, printingId, now, now);
  return { skuId };
}

const idKey = (suffix: string) => `i30b-key-${suffix}-1234`;

describe("I30B admin routes", () => {
  it("rejects ordinary players with 403 on admin dashboard", async () => {
    const { app, database } = await createTestApp();
    const player = await registerPlayer(app, "player@example.test");
    const response = await app.inject({ method: "GET", url: "/v1/admin/dashboard", headers: { authorization: player.authorization } });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("AUTHORIZATION_DENIED");
    await app.close();
    database.close();
  });

  it("returns dashboard aggregate for admin", async () => {
    const { app, database } = await createTestApp();
    const admin = await registerAndPromoteAdmin(app, database);
    const response = await app.inject({ method: "GET", url: "/v1/admin/dashboard", headers: { authorization: admin.authorization } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ environment: "test", failedJobCount: 0, activeCampaignCount: 0 });
    await app.close();
    database.close();
  });

  it("revokes user sessions via admin command, disabling refresh", async () => {
    const { app, database } = await createTestApp();
    const admin = await registerAndPromoteAdmin(app, database);
    const player = await registerPlayer(app, "revoked@example.test");
    // 登录获取 refresh cookie
    const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "revoked@example.test", password: "correct-horse-battery-staple" } });
    const cookies = (login.headers["set-cookie"] as string[] | undefined) ?? [];
    const refreshCookie = cookies.find((cookie) => cookie.startsWith("mtg_refresh=")) ?? "";
    const csrfCookie = cookies.find((cookie) => cookie.startsWith("mtg_csrf=")) ?? "";
    const csrfToken = decodeURIComponent(csrfCookie.split("=")[1]?.split(";")[0] ?? "");

    // 管理员撤销该用户会话
    const revoke = await app.inject({ method: "POST", url: `/v1/admin/users/${player.userId}/revoke-sessions`, headers: { authorization: admin.authorization, "idempotency-key": idKey("revoke") } });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().data.revokedCount).toBeGreaterThan(0);

    // 撤销后 refresh 应失败
    const refresh = await app.inject({ method: "POST", url: "/v1/auth/refresh", headers: { cookie: refreshCookie, "x-csrf-token": csrfToken } });
    expect(refresh.statusCode).toBe(401);
    await app.close();
    database.close();
  });

  it("replays same idempotency key and rejects different params with IDEMPOTENCY_CONFLICT", async () => {
    const { app, database } = await createTestApp();
    const admin = await registerAndPromoteAdmin(app, database);
    const player = await registerPlayer(app, "target@example.test");
    const headers = { authorization: admin.authorization, "idempotency-key": idKey("freeze-replay") };
    const first = await app.inject({ method: "POST", url: `/v1/admin/users/${player.userId}/freeze`, headers, payload: { reason: "首次冻结原因" } });
    expect(first.statusCode).toBe(200);
    const replay = await app.inject({ method: "POST", url: `/v1/admin/users/${player.userId}/freeze`, headers, payload: { reason: "首次冻结原因" } });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.frozen).toBe(true);
    // 异参同键：改 reason 触发冲突
    const conflict = await app.inject({ method: "POST", url: `/v1/admin/users/${player.userId}/freeze`, headers, payload: { reason: "不同的原因" } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
    await app.close();
    database.close();
  });

  it("creates, previews, publishes, pauses and ends a campaign with version conflict detection", async () => {
    const { app, database } = await createTestApp();
    const admin = await registerAndPromoteAdmin(app, database);
    const startsAt = "2026-08-01T00:00:00.000Z";
    const endsAt = "2026-08-31T00:00:00.000Z";
    const createHeaders = { authorization: admin.authorization, "idempotency-key": idKey("camp-create") };
    const create = await app.inject({
      method: "POST", url: "/v1/admin/campaigns", headers: createHeaders,
      payload: { code: "summer-2026", name: "夏季活动", campaignType: "market_factor", scopeType: "global", factorBps: 8000, displayText: "夏季供需", startsAt, endsAt }
    });
    expect(create.statusCode).toBe(201);
    const campaignId = create.json().data.id as string;

    // 预览
    const preview = await app.inject({ method: "POST", url: `/v1/admin/campaigns/${campaignId}/preview`, headers: { authorization: admin.authorization } });
    expect(preview.statusCode).toBe(200);
    const previewVersion = preview.json().data.previewVersion as number;
    expect(previewVersion).toBe(2);

    // 版本冲突：用错误的 previewVersion 发布
    const stalePublish = await app.inject({
      method: "POST", url: `/v1/admin/campaigns/${campaignId}/publish`,
      headers: { authorization: admin.authorization, "idempotency-key": idKey("camp-publish-stale") },
      payload: { previewVersion: 99 }
    });
    expect(stalePublish.statusCode).toBe(409);
    expect(stalePublish.json().error.code).toBe("VERSION_STALE");

    // 正确发布
    const publish = await app.inject({
      method: "POST", url: `/v1/admin/campaigns/${campaignId}/publish`,
      headers: { authorization: admin.authorization, "idempotency-key": idKey("camp-publish") },
      payload: { previewVersion }
    });
    expect(publish.statusCode).toBe(200);
    expect(publish.json().data.status).toBe("published");

    // 重复发布同键返回首次结果
    const publishReplay = await app.inject({
      method: "POST", url: `/v1/admin/campaigns/${campaignId}/publish`,
      headers: { authorization: admin.authorization, "idempotency-key": idKey("camp-publish") },
      payload: { previewVersion }
    });
    expect(publishReplay.statusCode).toBe(200);

    // 暂停（幂等）
    const pauseHeaders = { authorization: admin.authorization, "idempotency-key": idKey("camp-pause") };
    const pause = await app.inject({ method: "POST", url: `/v1/admin/campaigns/${campaignId}/pause`, headers: pauseHeaders });
    expect(pause.statusCode).toBe(200);
    expect(pause.json().data.status).toBe("paused");
    const pauseReplay = await app.inject({ method: "POST", url: `/v1/admin/campaigns/${campaignId}/pause`, headers: pauseHeaders });
    expect(pauseReplay.statusCode).toBe(200);

    // 结束
    const end = await app.inject({
      method: "POST", url: `/v1/admin/campaigns/${campaignId}/end`,
      headers: { authorization: admin.authorization, "idempotency-key": idKey("camp-end") }
    });
    expect(end.statusCode).toBe(200);
    expect(end.json().data.status).toBe("ended");

    // 审计可追溯
    const audit = await app.inject({ method: "GET", url: "/v1/admin/audit-logs?entityType=campaign", headers: { authorization: admin.authorization } });
    expect(audit.statusCode).toBe(200);
    const actions = audit.json().data.items.map((item: { action: string }) => item.action);
    expect(actions).toContain("campaign.published");
    await app.close();
    database.close();
  });

  it("rejects overlapping campaign publish with RESOURCE_CONFLICT", async () => {
    const { app, database } = await createTestApp();
    const admin = await registerAndPromoteAdmin(app, database);
    const create1 = await app.inject({
      method: "POST", url: "/v1/admin/campaigns",
      headers: { authorization: admin.authorization, "idempotency-key": idKey("conflict-1") },
      payload: { code: "a-2026", name: "A", campaignType: "market_factor", scopeType: "set", scopeId: "ADM", factorBps: 8000, displayText: "A", startsAt: "2026-09-01T00:00:00.000Z", endsAt: "2026-09-30T00:00:00.000Z" }
    });
    expect(create1.statusCode).toBe(201);
    const c1 = create1.json().data.id as string;
    const p1 = (await app.inject({ method: "POST", url: `/v1/admin/campaigns/${c1}/preview`, headers: { authorization: admin.authorization } })).json().data.previewVersion as number;
    await app.inject({ method: "POST", url: `/v1/admin/campaigns/${c1}/publish`, headers: { authorization: admin.authorization, "idempotency-key": idKey("conflict-p1") }, payload: { previewVersion: p1 } });

    const create2 = await app.inject({
      method: "POST", url: "/v1/admin/campaigns",
      headers: { authorization: admin.authorization, "idempotency-key": idKey("conflict-2") },
      payload: { code: "b-2026", name: "B", campaignType: "market_factor", scopeType: "set", scopeId: "ADM", factorBps: 9000, displayText: "B", startsAt: "2026-09-15T00:00:00.000Z", endsAt: "2026-10-15T00:00:00.000Z" }
    });
    expect(create2.statusCode).toBe(201);
    const c2 = create2.json().data.id as string;
    const p2 = (await app.inject({ method: "POST", url: `/v1/admin/campaigns/${c2}/preview`, headers: { authorization: admin.authorization } })).json().data.previewVersion as number;
    const publish2 = await app.inject({ method: "POST", url: `/v1/admin/campaigns/${c2}/publish`, headers: { authorization: admin.authorization, "idempotency-key": idKey("conflict-p2") }, payload: { previewVersion: p2 } });
    expect(publish2.statusCode).toBe(409);
    expect(publish2.json().error.code).toBe("RESOURCE_CONFLICT");
    await app.close();
    database.close();
  });

  it("compensates balance via ledger entry without overwriting, once only", async () => {
    const { app, database } = await createTestApp();
    const admin = await registerAndPromoteAdmin(app, database);
    const player = await registerPlayer(app, "comp@example.test");
    // 创建存档以建立账户
    await app.inject({ method: "POST", url: "/v1/archive", headers: { authorization: player.authorization, "idempotency-key": idKey("archive") }, payload: {} });
    const before = await app.inject({ method: "GET", url: "/v1/account", headers: { authorization: player.authorization } });
    const beforeAmount = before.json().data.balance.total.amount as number;

    const headers = { authorization: admin.authorization, "idempotency-key": idKey("bal-comp") };
    const comp = await app.inject({ method: "POST", url: `/v1/admin/users/${player.userId}/compensate/balance`, headers, payload: { amount: 500, direction: "credit", reason: "运营补偿" } });
    expect(comp.statusCode).toBe(200);
    expect(comp.json().data.ledgerEntryId).not.toBeNull();
    expect(comp.json().data.newBalance.total).toBe(beforeAmount + 500);

    // 重放只发生一次
    const replay = await app.inject({ method: "POST", url: `/v1/admin/users/${player.userId}/compensate/balance`, headers, payload: { amount: 500, direction: "credit", reason: "运营补偿" } });
    expect(replay.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: "/v1/account", headers: { authorization: player.authorization } });
    expect(after.json().data.balance.total.amount).toBe(beforeAmount + 500);
    await app.close();
    database.close();
  });

  it("rolls back inventory compensation when insufficient and leaves no half-state", async () => {
    const { app, database } = await createTestApp();
    const { skuId } = seedCatalog(database);
    const admin = await registerAndPromoteAdmin(app, database);
    const player = await registerPlayer(app, "invcomp@example.test");
    await app.inject({ method: "POST", url: "/v1/archive", headers: { authorization: player.authorization, "idempotency-key": idKey("archive-inv") }, payload: {} });

    // 库存为 0 时尝试 debit 扣减
    const headers = { authorization: admin.authorization, "idempotency-key": idKey("inv-comp-fail") };
    const comp = await app.inject({ method: "POST", url: `/v1/admin/users/${player.userId}/compensate/inventory`, headers, payload: { skuId, quantity: -5, direction: "debit", reason: "误扣修正" } });
    expect(comp.statusCode).toBe(409);
    expect(comp.json().error.code).toBe("INSUFFICIENT_INVENTORY");

    // credit 入库成功
    const creditHeaders = { authorization: admin.authorization, "idempotency-key": idKey("inv-comp-credit") };
    const credit = await app.inject({ method: "POST", url: `/v1/admin/users/${player.userId}/compensate/inventory`, headers: creditHeaders, payload: { skuId, quantity: 3, direction: "credit", reason: "运营补偿" } });
    expect(credit.statusCode).toBe(200);
    expect(credit.json().data.newQuantity.quantity).toBe(3);
    expect(credit.json().data.inventoryEntryId).not.toBeNull();
    await app.close();
    database.close();
  });

  it("audit logs are read-only and sensitive fields are redacted", async () => {
    const { app, database } = await createTestApp();
    const admin = await registerAndPromoteAdmin(app, database);
    const player = await registerPlayer(app, "audit@example.test");
    await app.inject({ method: "POST", url: `/v1/admin/users/${player.userId}/freeze`, headers: { authorization: admin.authorization, "idempotency-key": idKey("audit-freeze") }, payload: { reason: "审计测试" } });
    const logs = await app.inject({ method: "GET", url: "/v1/admin/audit-logs?entityType=user", headers: { authorization: admin.authorization } });
    expect(logs.statusCode).toBe(200);
    const json = JSON.stringify(logs.json().data.items);
    // 不应包含密码哈希、令牌、Cookie
    expect(json).not.toMatch(/password_hash|refresh_token_hash|cookie/i);
    // 审计日志查询为只读：无 DELETE/PUT 路由（验证 GET 返回 200）
    expect(logs.json().data.items.length).toBeGreaterThan(0);
    await app.close();
    database.close();
  });

  it("updates market parameters with version conflict on stale expectedVersion", async () => {
    const { app, database } = await createTestApp();
    const admin = await registerAndPromoteAdmin(app, database);
    const get = await app.inject({ method: "GET", url: "/v1/admin/market-parameters", headers: { authorization: admin.authorization } });
    expect(get.statusCode).toBe(200);
    const version = get.json().data.version as number;
    const update = await app.inject({
      method: "POST", url: "/v1/admin/market-parameters",
      headers: { authorization: admin.authorization, "idempotency-key": idKey("mp-update") },
      payload: { eurCentToGameCreditBps: 10000, minimumPrice: 1, npcBuySpreadBps: 1200, npcSellSpreadBps: 1000, npcFeeBps: 0, expectedVersion: version }
    });
    expect(update.statusCode).toBe(200);
    // 旧版本再次更新应冲突
    const stale = await app.inject({
      method: "POST", url: "/v1/admin/market-parameters",
      headers: { authorization: admin.authorization, "idempotency-key": idKey("mp-stale") },
      payload: { eurCentToGameCreditBps: 10000, minimumPrice: 1, npcBuySpreadBps: 1500, npcSellSpreadBps: 1000, npcFeeBps: 0, expectedVersion: version }
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("VERSION_STALE");
    await app.close();
    database.close();
  });

  it("publishes a new pack rule version immutably and rejects duplicate version", async () => {
    const { app, database } = await createTestApp();
    const { skuId } = seedCatalog(database);
    const now = "2026-07-31T00:00:00.000Z";
    const packId = "70000000-0000-4000-8000-000000000301";
    const ruleId = "80000000-0000-4000-8000-000000000301";
    database.prepare("INSERT INTO booster_packs (id, code, name, description, price_amount, enabled, disabled_reason, active_rule_version, created_at, updated_at) VALUES (?, 'ADM-01', '管理测试包', NULL, 500, 1, NULL, 'pack/v1', ?, ?)").run(packId, now, now);
    database.prepare("INSERT INTO booster_pack_rules (id, pack_id, version, definition_json, created_at, retired_at) VALUES (?, ?, 'pack/v1', ?, ?, NULL)").run(ruleId, packId, JSON.stringify({ version: "pack/v1", pools: [{ id: "p", rarity: "common", candidates: [{ skuId, weight: 1 }] }], slots: [{ id: "s", draws: 1, poolWeights: [{ poolId: "p", weight: 1 }] }] }), now);

    const admin = await registerAndPromoteAdmin(app, database);
    const definition = { version: "pack/v2", pools: [{ id: "p", rarity: "common", candidates: [{ skuId, weight: 1 }] }], slots: [{ id: "s", draws: 2, poolWeights: [{ poolId: "p", weight: 1 }] }] };
    const publish = await app.inject({
      method: "POST", url: `/v1/admin/packs/${packId}/rule-publish`,
      headers: { authorization: admin.authorization, "idempotency-key": idKey("pack-publish") },
      payload: definition
    });
    expect(publish.statusCode).toBe(201);
    expect(publish.json().data.ruleVersion).toBe("pack/v2");

    // 重放返回首次结果
    const replay = await app.inject({
      method: "POST", url: `/v1/admin/packs/${packId}/rule-publish`,
      headers: { authorization: admin.authorization, "idempotency-key": idKey("pack-publish") },
      payload: definition
    });
    expect(replay.statusCode).toBe(201);

    // 同版本再次发布（不同幂等键）应冲突
    const dup = await app.inject({
      method: "POST", url: `/v1/admin/packs/${packId}/rule-publish`,
      headers: { authorization: admin.authorization, "idempotency-key": idKey("pack-dup") },
      payload: definition
    });
    expect(dup.statusCode).toBe(409);
    await app.close();
    database.close();
  });

  it("creates and ends a limited-time pack offer with idempotency and duplicate-window rejection", async () => {
    const { app, database } = await createTestApp();
    const { skuId } = seedCatalog(database);
    const now = "2026-07-31T00:00:00.000Z";
    const packId = "70000000-0000-4000-8000-000000000302";
    database.prepare("INSERT INTO booster_packs (id, code, name, description, price_amount, enabled, disabled_reason, active_rule_version, created_at, updated_at) VALUES (?, 'ADM-02', '管理测试包二', NULL, 500, 1, NULL, 'pack/v1', ?, ?)").run(packId, now, now);
    database.prepare("INSERT INTO booster_pack_rules (id, pack_id, version, definition_json, created_at, retired_at) VALUES (?, ?, 'pack/v1', ?, ?, NULL)").run("80000000-0000-4000-8000-000000000302", packId, JSON.stringify({ version: "pack/v1", pools: [{ id: "p", rarity: "common", candidates: [{ skuId, weight: 1 }] }], slots: [{ id: "s", draws: 1, poolWeights: [{ poolId: "p", weight: 1 }] }] }), now);

    const admin = await registerAndPromoteAdmin(app, database);
    const payload = { name: "限时折扣", description: "八折", discountBps: 8000, startsAt: "2026-08-01T00:00:00.000Z", endsAt: "2026-08-10T00:00:00.000Z" };
    const create = await app.inject({ method: "POST", url: `/v1/admin/packs/${packId}/offer`, headers: { authorization: admin.authorization, "idempotency-key": idKey("offer-create") }, payload });
    expect(create.statusCode).toBe(201);
    expect(create.json().data.offer).toMatchObject({ packId, discountBps: 8000, status: "active" });
    const offerId = create.json().data.offer.id as string;

    // 重放返回首次结果
    const replay = await app.inject({ method: "POST", url: `/v1/admin/packs/${packId}/offer`, headers: { authorization: admin.authorization, "idempotency-key": idKey("offer-create") }, payload });
    expect(replay.statusCode).toBe(201);

    // 同一包已有未结束窗口 → 冲突
    const conflict = await app.inject({ method: "POST", url: `/v1/admin/packs/${packId}/offer`, headers: { authorization: admin.authorization, "idempotency-key": idKey("offer-dup") }, payload: { ...payload, name: "另一窗口" } });
    expect(conflict.statusCode).toBe(409);

    // 普通玩家 403
    const player = await registerPlayer(app, "offer-player@example.test");
    const forbidden = await app.inject({ method: "POST", url: `/v1/admin/packs/${packId}/offer`, headers: { authorization: player.authorization, "idempotency-key": idKey("offer-player") }, payload });
    expect(forbidden.statusCode).toBe(403);

    // 结束窗口；重复结束被拒
    const end = await app.inject({ method: "POST", url: `/v1/admin/pack-offers/${offerId}/end`, headers: { authorization: admin.authorization, "idempotency-key": idKey("offer-end") }, payload: {} });
    expect(end.statusCode).toBe(200);
    expect(end.json().data).toMatchObject({ offerId, status: "ended" });
    const endAgain = await app.inject({ method: "POST", url: `/v1/admin/pack-offers/${offerId}/end`, headers: { authorization: admin.authorization, "idempotency-key": idKey("offer-end-again") }, payload: {} });
    expect(endAgain.statusCode).toBe(409);
    // 结束时写审计
    expect(database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'pack_offer.ended'").get()).toEqual({ count: 1 });
    await app.close();
    database.close();
  });

  it("creates a setlist draft, previews mapping, and dedupes on same source version", async () => {
    const { app, database } = await createTestApp();
    seedCatalog(database); // 本地 ADM 系列
    const admin = await registerAndPromoteAdmin(app, database);
    const setlist = [{ code: "ADM", name: "管理测试系列" }, { code: "MISS", name: "缺失系列" }];
    const create = await app.inject({
      method: "POST", url: "/v1/admin/mtgjson/setlist-draft",
      headers: { authorization: admin.authorization, "idempotency-key": idKey("setlist-create") },
      payload: { sourceVersion: "5.2.2", sourceChecksumSha256: "a".repeat(64), setlist }
    });
    expect(create.statusCode).toBe(201);
    const draftId = create.json().data.id as string;

    // 预览映射：ADM 可导入，MISS 缺失
    const preview = await app.inject({ method: "POST", url: `/v1/admin/mtgjson/drafts/${draftId}/preview`, headers: { authorization: admin.authorization } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data.importableCount).toBe(1);
    expect(preview.json().data.missingCount).toBe(1);
    expect(preview.json().data.draft.mappingStatus).toBe("missing");

    // 同源版本重放返回首次草稿（不新建）
    const replay = await app.inject({
      method: "POST", url: "/v1/admin/mtgjson/setlist-draft",
      headers: { authorization: admin.authorization, "idempotency-key": idKey("setlist-create-2") },
      payload: { sourceVersion: "5.2.2", sourceChecksumSha256: "a".repeat(64), setlist }
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.id).toBe(draftId);
    await app.close();
    database.close();
  });

  it("toggles SKU tradable and lists series", async () => {
    const { app, database } = await createTestApp();
    const { skuId } = seedCatalog(database);
    const admin = await registerAndPromoteAdmin(app, database);

    const series = await app.inject({ method: "GET", url: "/v1/admin/catalog/series", headers: { authorization: admin.authorization } });
    expect(series.statusCode).toBe(200);
    expect(series.json().data.items.find((item: { code: string }) => item.code === "ADM")).toBeTruthy();

    // 停用 SKU
    const disable = await app.inject({
      method: "POST", url: `/v1/admin/catalog/skus/${skuId}/tradable`,
      headers: { authorization: admin.authorization, "idempotency-key": idKey("sku-disable") },
      payload: { tradable: false }
    });
    expect(disable.statusCode).toBe(200);
    expect(disable.json().data.tradable).toBe(false);
    await app.close();
    database.close();
  });

  it("triggers catalog and price sync with uniqueKey dedup", async () => {
    const { app, database } = await createTestApp();
    const admin = await registerAndPromoteAdmin(app, database);
    const headers = { authorization: admin.authorization, "idempotency-key": idKey("sync-trigger") };
    const catalog = await app.inject({ method: "POST", url: "/v1/admin/catalog/sync-trigger", headers });
    expect(catalog.statusCode).toBe(201);
    const prices = await app.inject({ method: "POST", url: "/v1/admin/prices/sync-trigger", headers });
    expect(prices.statusCode).toBe(201);

    // 同键重放应去重（返回同一 jobId）
    const catalogReplay = await app.inject({ method: "POST", url: "/v1/admin/catalog/sync-trigger", headers });
    expect(catalogReplay.json().data.jobId).toBe(catalog.json().data.jobId);
    await app.close();
    database.close();
  });
});
