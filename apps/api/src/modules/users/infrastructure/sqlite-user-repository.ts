import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  AccountBalanceDto,
  DailyWorkFundingDto,
  GameArchiveSummaryDto,
  LedgerEntryDto,
  Page
} from "@mtg-market/contracts";
import { assertPositiveMinorUnits, type FundHoldTarget } from "../domain/funds.js";

type ArchiveRow = {
  archive_id: string;
  user_id: string;
  initial_funding_rule_version: string;
  archive_created_at: string;
  account_id: string;
  currency: "GAME_CREDIT";
  total_amount: number;
  available_amount: number;
  frozen_amount: number;
  updated_at: string;
};
type AccountRow = {
  id: string;
  user_id: string;
  currency: "GAME_CREDIT";
  total_amount: number;
  available_amount: number;
  frozen_amount: number;
  updated_at: string;
};
type BalanceRow = Pick<
  AccountRow,
  "currency" | "total_amount" | "available_amount" | "frozen_amount" | "updated_at"
>;
type LedgerRow = {
  id: string;
  user_id: string;
  direction: "credit" | "debit";
  amount: number;
  balance_after: number;
  reason: string;
  correlation_id: string;
  occurred_at: string;
};
type DailyRolloverRow = {
  id: string;
  natural_date: string;
  timezone: string;
  work_funding_rule_version: string;
  work_funding_amount: number;
  opened_at: string;
};
type DailyWorkFundingRow = {
  id: string;
  natural_date: string;
  timezone: string;
  rule_version: string;
  amount: number;
  claimed_at: string;
};

function balance(row: BalanceRow): AccountBalanceDto {
  return {
    total: { amount: row.total_amount, currency: row.currency },
    available: { amount: row.available_amount, currency: row.currency },
    frozen: { amount: row.frozen_amount, currency: row.currency },
    updatedAt: row.updated_at
  };
}

function archiveSummary(row: ArchiveRow): GameArchiveSummaryDto {
  return {
    id: row.archive_id,
    userId: row.user_id,
    initialFundingRuleVersion: row.initial_funding_rule_version,
    createdAt: row.archive_created_at,
    balance: balance(row),
    netWorth: null
  };
}

function dailyWorkFunding(row: DailyWorkFundingRow): DailyWorkFundingDto {
  return {
    id: row.id,
    naturalDate: row.natural_date,
    timezone: row.timezone,
    amount: { amount: row.amount, currency: "GAME_CREDIT" },
    ruleVersion: row.rule_version,
    claimedAt: row.claimed_at
  };
}

/** SQLite 是 users 模块账户与账本的唯一存储适配器。所有写方法须由 application 短事务调用。 */
export class SqliteUserRepository {
  constructor(private readonly database: Database.Database) {}

  findArchive(userId: string): GameArchiveSummaryDto | null {
    const row = this.database
      .prepare(
        `SELECT ga.id AS archive_id, ga.user_id, ga.initial_funding_rule_version, ga.created_at AS archive_created_at,
      a.id AS account_id, a.currency, a.total_amount, a.available_amount, a.frozen_amount, a.updated_at
      FROM game_archives ga JOIN accounts a ON a.user_id = ga.user_id AND a.currency = 'GAME_CREDIT' WHERE ga.user_id = ?`
      )
      .get(userId) as ArchiveRow | undefined;
    return row ? archiveSummary(row) : null;
  }

  createArchive(
    userId: string,
    ruleVersion: string,
    amount: number,
    now: string,
    correlationId: string
  ): GameArchiveSummaryDto {
    assertPositiveMinorUnits(amount);
    const archiveId = randomUUID();
    const accountId = randomUUID();
    this.database
      .prepare(
        "INSERT INTO game_archives (id, user_id, initial_funding_rule_version, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(archiveId, userId, ruleVersion, now);
    this.database
      .prepare(
        "INSERT INTO accounts (id, user_id, currency, total_amount, available_amount, frozen_amount, updated_at) VALUES (?, ?, 'GAME_CREDIT', ?, ?, 0, ?)"
      )
      .run(accountId, userId, amount, amount, now);
    this.database
      .prepare(
        "INSERT INTO ledger_entries (id, account_id, direction, amount, balance_after, reason, correlation_id, occurred_at) VALUES (?, ?, 'credit', ?, ?, 'initial_funding', ?, ?)"
      )
      .run(randomUUID(), accountId, amount, amount, correlationId, now);
    return this.findArchive(userId)!;
  }

  getBalance(userId: string): AccountBalanceDto | null {
    const row = this.database
      .prepare(
        "SELECT id, user_id, currency, total_amount, available_amount, frozen_amount, updated_at FROM accounts WHERE user_id = ? AND currency = 'GAME_CREDIT'"
      )
      .get(userId) as AccountRow | undefined;
    return row ? balance(row) : null;
  }

  listLedger(userId: string, cursor: string | undefined, limit: number): Page<LedgerEntryDto> {
    const account = this.database
      .prepare("SELECT id FROM accounts WHERE user_id = ? AND currency = 'GAME_CREDIT'")
      .get(userId) as { id: string } | undefined;
    if (!account) return { items: [], page: { nextCursor: null, hasMore: false } };
    const offset = cursor ? Number.parseInt(cursor, 10) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("账本分页游标无效");
    const rows = this.database
      .prepare(
        `SELECT l.id, a.user_id, l.direction, l.amount, l.balance_after, l.reason, l.correlation_id, l.occurred_at
      FROM ledger_entries l JOIN accounts a ON a.id = l.account_id WHERE l.account_id = ? ORDER BY l.occurred_at DESC, l.id DESC LIMIT ? OFFSET ?`
      )
      .all(account.id, limit + 1, offset) as LedgerRow[];
    const hasMore = rows.length > limit;
    const visible = rows.slice(0, limit);
    return {
      items: visible.map((row) => ({
        id: row.id,
        userId: row.user_id,
        direction: row.direction,
        amount: { amount: row.amount, currency: "GAME_CREDIT" },
        balanceAfter: { amount: row.balance_after, currency: "GAME_CREDIT" },
        reason: row.reason,
        correlationId: row.correlation_id,
        occurredAt: row.occurred_at
      })),
      page: { hasMore, nextCursor: hasMore ? String(offset + limit) : null }
    };
  }

  /** 日切行是日期配置快照；同一自然日冲突时绝不改写已开放规则。 */
  openDailyRollover(input: {
    naturalDate: string;
    timezone: string;
    ruleVersion: string;
    amount: number;
    openedAt: string;
  }): DailyRolloverRow {
    const id = randomUUID();
    this.database.prepare(
      `INSERT INTO daily_rollover_runs (id, natural_date, timezone, work_funding_rule_version, work_funding_amount, opened_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(natural_date) DO NOTHING`
    ).run(id, input.naturalDate, input.timezone, input.ruleVersion, input.amount, input.openedAt);
    return this.findDailyRollover(input.naturalDate)!;
  }

  findDailyRollover(naturalDate: string): DailyRolloverRow | null {
    const row = this.database.prepare(
      "SELECT id, natural_date, timezone, work_funding_rule_version, work_funding_amount, opened_at FROM daily_rollover_runs WHERE natural_date = ?"
    ).get(naturalDate) as DailyRolloverRow | undefined;
    return row ?? null;
  }

  findDailyWorkFunding(userId: string, naturalDate: string): DailyWorkFundingDto | null {
    const row = this.database.prepare(
      `SELECT c.id, c.natural_date, r.timezone, c.rule_version, c.amount, c.claimed_at
       FROM daily_work_funding_claims c JOIN daily_rollover_runs r ON r.id = c.rollover_id
       WHERE c.user_id = ? AND c.natural_date = ?`
    ).get(userId, naturalDate) as DailyWorkFundingRow | undefined;
    return row ? dailyWorkFunding(row) : null;
  }

  createDailyWorkFunding(input: {
    rolloverId: string;
    userId: string;
    naturalDate: string;
    ruleVersion: string;
    amount: number;
    idempotencyKey: string;
    claimedAt: string;
  }): DailyWorkFundingDto {
    const id = randomUUID();
    this.database.prepare(
      `INSERT INTO daily_work_funding_claims
       (id, rollover_id, user_id, natural_date, rule_version, amount, idempotency_key, claimed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, input.rolloverId, input.userId, input.naturalDate, input.ruleVersion, input.amount, input.idempotencyKey, input.claimedAt);
    return this.findDailyWorkFunding(input.userId, input.naturalDate)!;
  }

  reserveFunds(
    userId: string,
    amount: number,
    target: FundHoldTarget,
    now: string
  ): { holdId: string; balance: AccountBalanceDto } | "insufficient" {
    assertPositiveMinorUnits(amount);
    const account = this.accountForUpdate(userId);
    if (!account || account.available_amount < amount) return "insufficient";
    const changed = this.database
      .prepare(
        "UPDATE accounts SET available_amount = available_amount - ?, frozen_amount = frozen_amount + ?, updated_at = ? WHERE id = ? AND available_amount >= ?"
      )
      .run(amount, amount, now, account.id, amount);
    if (changed.changes !== 1) return "insufficient";
    const holdId = randomUUID();
    this.database
      .prepare(
        "INSERT INTO fund_holds (id, account_id, amount, reason, entity_type, entity_id, status, created_at, released_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL)"
      )
      .run(holdId, account.id, amount, target.reason, target.entityType, target.entityId, now);
    return { holdId, balance: this.getBalance(userId)! };
  }

  releaseFunds(userId: string, holdId: string, now: string): AccountBalanceDto | "not-active" {
    const hold = this.database
      .prepare(
        "SELECT h.account_id, h.amount FROM fund_holds h JOIN accounts a ON a.id = h.account_id WHERE h.id = ? AND a.user_id = ? AND h.status = 'active'"
      )
      .get(holdId, userId) as { account_id: string; amount: number } | undefined;
    if (!hold) return "not-active";
    const changed = this.database
      .prepare(
        "UPDATE fund_holds SET status = 'released', released_at = ? WHERE id = ? AND status = 'active'"
      )
      .run(now, holdId);
    if (changed.changes !== 1) return "not-active";
    this.database
      .prepare(
        "UPDATE accounts SET available_amount = available_amount + ?, frozen_amount = frozen_amount - ?, updated_at = ? WHERE id = ?"
      )
      .run(hold.amount, hold.amount, now, hold.account_id);
    return this.getBalance(userId)!;
  }

  captureFunds(
    userId: string,
    holdId: string,
    now: string,
    correlationId: string
  ): AccountBalanceDto | "not-active" {
    const hold = this.database
      .prepare(
        "SELECT h.account_id, h.amount, h.reason FROM fund_holds h JOIN accounts a ON a.id = h.account_id WHERE h.id = ? AND a.user_id = ? AND h.status = 'active'"
      )
      .get(holdId, userId) as { account_id: string; amount: number; reason: string } | undefined;
    if (!hold) return "not-active";
    const changed = this.database
      .prepare(
        "UPDATE fund_holds SET status = 'captured', released_at = ? WHERE id = ? AND status = 'active'"
      )
      .run(now, holdId);
    if (changed.changes !== 1) return "not-active";
    this.database
      .prepare(
        "UPDATE accounts SET total_amount = total_amount - ?, frozen_amount = frozen_amount - ?, updated_at = ? WHERE id = ? AND frozen_amount >= ? AND total_amount >= ?"
      )
      .run(hold.amount, hold.amount, now, hold.account_id, hold.amount, hold.amount);
    const after = this.getBalance(userId)!;
    this.database
      .prepare(
        "INSERT INTO ledger_entries (id, account_id, direction, amount, balance_after, reason, correlation_id, occurred_at) VALUES (?, ?, 'debit', ?, ?, ?, ?, ?)"
      )
      .run(
        randomUUID(),
        hold.account_id,
        hold.amount,
        after.total.amount,
        hold.reason,
        correlationId,
        now
      );
    return after;
  }

  /** 已结算消费直接减少总额与可用额，并追加账本；调用方必须处于经济短事务。 */
  spendAvailableFunds(
    userId: string,
    amount: number,
    now: string,
    correlationId: string,
    reason = "pack_purchase"
  ): AccountBalanceDto | "insufficient" {
    if (!Number.isSafeInteger(amount) || amount < 0)
      throw new RangeError("消费金额必须是非负安全整数最小单位");
    const account = this.accountForUpdate(userId);
    if (!account || account.available_amount < amount) return "insufficient";
    if (amount === 0) return balance(account);
    const changed = this.database
      .prepare(
        "UPDATE accounts SET total_amount = total_amount - ?, available_amount = available_amount - ?, updated_at = ? WHERE id = ? AND total_amount >= ? AND available_amount >= ?"
      )
      .run(amount, amount, now, account.id, amount, amount);
    if (changed.changes !== 1) return "insufficient";
    const after = this.getBalance(userId)!;
    this.database
      .prepare(
        "INSERT INTO ledger_entries (id, account_id, direction, amount, balance_after, reason, correlation_id, occurred_at) VALUES (?, ?, 'debit', ?, ?, ?, ?, ?)"
      )
      .run(randomUUID(), account.id, amount, after.total.amount, reason, correlationId, now);
    return after;
  }

  /** 已结算收入直接增加总额与可用额，并追加账本；调用方必须处于经济短事务。 */
  creditAvailableFunds(
    userId: string,
    amount: number,
    now: string,
    correlationId: string,
    reason: string
  ): AccountBalanceDto | "missing" {
    if (!Number.isSafeInteger(amount) || amount < 0)
      throw new RangeError("收入金额必须是非负安全整数最小单位");
    const account = this.accountForUpdate(userId);
    if (!account) return "missing";
    const changed = this.database
      .prepare(
        "UPDATE accounts SET total_amount = total_amount + ?, available_amount = available_amount + ?, updated_at = ? WHERE id = ?"
      )
      .run(amount, amount, now, account.id);
    if (changed.changes !== 1) throw new Error("账户收入写入失败");
    const after = this.getBalance(userId)!;
    this.database
      .prepare(
        "INSERT INTO ledger_entries (id, account_id, direction, amount, balance_after, reason, correlation_id, occurred_at) VALUES (?, ?, 'credit', ?, ?, ?, ?, ?)"
      )
      .run(randomUUID(), account.id, amount, after.total.amount, reason, correlationId, now);
    return after;
  }

  writeAudit(
    actorId: string | null,
    action: string,
    entityType: string,
    entityId: string,
    requestId: string,
    summary: Record<string, unknown>,
    now: string
  ): void {
    this.database
      .prepare(
        "INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, request_id, summary_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        randomUUID(),
        actorId,
        action,
        entityType,
        entityId,
        requestId,
        JSON.stringify(summary),
        now
      );
  }

  private accountForUpdate(userId: string): AccountRow | undefined {
    return this.database
      .prepare(
        "SELECT id, user_id, currency, total_amount, available_amount, frozen_amount, updated_at FROM accounts WHERE user_id = ? AND currency = 'GAME_CREDIT'"
      )
      .get(userId) as AccountRow | undefined;
  }
}
