import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "@mtg-market/database";
import { DailyRolloverService } from "./daily-rollover-service.js";
import { UserService } from "./user-service.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "mtg-daily-work-funding-"));
  directories.push(directory);
  const database = openSqliteDatabase(join(directory, "daily.db"));
  database.prepare(
    "INSERT INTO users (id, email, display_name, password_hash, role, created_at, updated_at) VALUES ('player-1', 'daily@example.test', '每日玩家', 'hash', 'player', '2026-03-08T00:00:00.000Z', '2026-03-08T00:00:00.000Z')"
  ).run();
  return database;
}

function createArchive(users: UserService) {
  expect(users.createArchive({ userId: "player-1", idempotencyKey: "daily-archive-create-0001", requestFingerprint: "a".repeat(64), requestId: "request-daily-archive" }).state).toBe("created");
}

describe("I23B daily.rollover 与每日工作资金", () => {
  it("日切只开放日期资格；同日重放不重复审计或入账，领取同键重放只返回首次结果", () => {
    const database = fixture();
    const rollover = new DailyRolloverService(database);
    const users = new UserService(database, { timezone: "America/New_York", ruleVersion: "daily-work-funds/v1" });
    createArchive(users);
    const payload = { naturalDate: "2026-03-08", timezone: "America/New_York", workFundingRuleVersion: "daily-work-funds/v1" } as const;
    rollover.rollover(payload, new Date("2026-03-08T05:00:00.000Z"));
    rollover.rollover(payload, new Date("2026-03-08T05:01:00.000Z"));
    expect(database.prepare("SELECT COUNT(*) AS count FROM daily_rollover_runs").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'daily.rollover.opened'").get()).toEqual({ count: 1 });

    const first = users.claimDailyWorkFunding({ userId: "player-1", idempotencyKey: "daily-claim-20260308", requestFingerprint: "b".repeat(64), requestId: "request-daily-claim-1", now: new Date("2026-03-08T06:00:00.000Z") });
    const replay = users.claimDailyWorkFunding({ userId: "player-1", idempotencyKey: "daily-claim-20260308", requestFingerprint: "b".repeat(64), requestId: "request-daily-claim-2", now: new Date("2026-03-08T06:01:00.000Z") });
    expect(first).toMatchObject({ state: "claimed", response: { data: { funding: { naturalDate: "2026-03-08", amount: { amount: 1000 }, ruleVersion: "daily-work-funds/v1" } } } });
    expect(replay).toMatchObject({ state: "replayed" });
    expect((replay as Extract<typeof replay, { state: "replayed" }>).response).toEqual((first as Extract<typeof first, { state: "claimed" }>).response);
    expect(database.prepare("SELECT COUNT(*) AS count FROM daily_work_funding_claims").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT total_amount, available_amount, frozen_amount FROM accounts WHERE user_id = 'player-1'").get()).toEqual({ total_amount: 11_000, available_amount: 11_000, frozen_amount: 0 });
    expect(database.prepare("SELECT reason, correlation_id FROM ledger_entries WHERE reason = 'daily_work_funding'").get()).toEqual({ reason: "daily_work_funding", correlation_id: "daily-work-funding:player-1:2026-03-08" });
    database.close();
  });

  it("跨日、DST 与停机补跑始终使用任务快照日期；新日必须重新开放才可领取", () => {
    const database = fixture();
    const rollover = new DailyRolloverService(database);
    const users = new UserService(database, { timezone: "America/New_York", ruleVersion: "daily-work-funds/v1" });
    createArchive(users);
    // 此任务在 DST 日排队，却在两天后恢复执行；它只能打开 3 月 8 日，不能错发为 3 月 10 日。
    rollover.rollover({ naturalDate: "2026-03-08", timezone: "America/New_York", workFundingRuleVersion: "daily-work-funds/v1" }, new Date("2026-03-10T12:00:00.000Z"));
    expect(users.dailyWorkFundingStatus("player-1", new Date("2026-03-10T12:00:00.000Z"))).toMatchObject({ naturalDate: "2026-03-10", status: "not_open" });
    expect(users.claimDailyWorkFunding({ userId: "player-1", idempotencyKey: "daily-claim-20260310", requestFingerprint: "c".repeat(64), requestId: "request-daily-late", now: new Date("2026-03-10T12:00:00.000Z") })).toEqual({ state: "not-open" });
    rollover.rollover({ naturalDate: "2026-03-10", timezone: "America/New_York", workFundingRuleVersion: "daily-work-funds/v1" }, new Date("2026-03-10T12:01:00.000Z"));
    expect(users.dailyWorkFundingStatus("player-1", new Date("2026-03-10T12:02:00.000Z"))).toMatchObject({ naturalDate: "2026-03-10", status: "available", nextEligibleAt: "2026-03-11T04:00:00.000Z" });
    database.close();
  });

  it("规则配置切换只影响之后开放的日期；历史金额和版本保持原样", () => {
    const database = fixture();
    const rollover = new DailyRolloverService(database);
    const v1 = new UserService(database, { timezone: "Asia/Shanghai", ruleVersion: "daily-work-funds/v1" });
    createArchive(v1);
    rollover.rollover({ naturalDate: "2026-04-01", timezone: "Asia/Shanghai", workFundingRuleVersion: "daily-work-funds/v1" }, new Date("2026-03-31T16:00:00.000Z"));
    expect(v1.claimDailyWorkFunding({ userId: "player-1", idempotencyKey: "daily-claim-v1-20260401", requestFingerprint: "d".repeat(64), requestId: "request-daily-v1", now: new Date("2026-03-31T16:01:00.000Z") })).toMatchObject({ state: "claimed", response: { data: { funding: { amount: { amount: 1000 }, ruleVersion: "daily-work-funds/v1" } } } });
    const v2 = new UserService(database, { timezone: "Asia/Shanghai", ruleVersion: "daily-work-funds/v2" });
    expect(v2.dailyWorkFundingStatus("player-1", new Date("2026-03-31T16:02:00.000Z"))).toMatchObject({ status: "claimed", amount: { amount: 1000 }, ruleVersion: "daily-work-funds/v1" });
    rollover.rollover({ naturalDate: "2026-04-02", timezone: "Asia/Shanghai", workFundingRuleVersion: "daily-work-funds/v2" }, new Date("2026-04-01T16:00:00.000Z"));
    expect(v2.claimDailyWorkFunding({ userId: "player-1", idempotencyKey: "daily-claim-v2-20260402", requestFingerprint: "e".repeat(64), requestId: "request-daily-v2", now: new Date("2026-04-01T16:01:00.000Z") })).toMatchObject({ state: "claimed", response: { data: { funding: { amount: { amount: 1200 }, ruleVersion: "daily-work-funds/v2" } } } });
    expect(database.prepare("SELECT natural_date, rule_version, amount FROM daily_work_funding_claims ORDER BY natural_date").all()).toEqual([
      { natural_date: "2026-04-01", rule_version: "daily-work-funds/v1", amount: 1000 },
      { natural_date: "2026-04-02", rule_version: "daily-work-funds/v2", amount: 1200 }
    ]);
    database.close();
  });

  it("同日换幂等键会被用户+日期唯一约束拦截，资金和账本不会再增加", () => {
    const database = fixture();
    const rollover = new DailyRolloverService(database);
    const users = new UserService(database);
    createArchive(users);
    rollover.rollover({ naturalDate: "2026-04-01", timezone: "Asia/Shanghai", workFundingRuleVersion: "daily-work-funds/v1" }, new Date("2026-03-31T16:00:00.000Z"));
    expect(users.claimDailyWorkFunding({ userId: "player-1", idempotencyKey: "daily-claim-unique-01", requestFingerprint: "f".repeat(64), requestId: "request-daily-unique-1", now: new Date("2026-03-31T16:01:00.000Z") }).state).toBe("claimed");
    expect(users.claimDailyWorkFunding({ userId: "player-1", idempotencyKey: "daily-claim-unique-02", requestFingerprint: "f".repeat(64), requestId: "request-daily-unique-2", now: new Date("2026-03-31T16:02:00.000Z") })).toEqual({ state: "already-claimed" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM ledger_entries WHERE reason = 'daily_work_funding'").get()).toEqual({ count: 1 });
    database.close();
  });
});
