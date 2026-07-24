import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AccountBalanceDto, GameArchiveSummaryDto, LedgerEntryDto, Page } from "@mtg-market/contracts";
import { assertPositiveMinorUnits, type FundHoldTarget } from "../domain/funds.js";

type ArchiveRow = { archive_id: string; user_id: string; initial_funding_rule_version: string; archive_created_at: string; account_id: string; currency: "GAME_CREDIT"; total_amount: number; available_amount: number; frozen_amount: number; updated_at: string };
type AccountRow = { id: string; user_id: string; currency: "GAME_CREDIT"; total_amount: number; available_amount: number; frozen_amount: number; updated_at: string };
type BalanceRow = Pick<AccountRow, "currency" | "total_amount" | "available_amount" | "frozen_amount" | "updated_at">;
type LedgerRow = { id: string; user_id: string; direction: "credit" | "debit"; amount: number; balance_after: number; reason: string; correlation_id: string; occurred_at: string };

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

/** SQLite 是 users 模块账户与账本的唯一存储适配器。所有写方法须由 application 短事务调用。 */
export class SqliteUserRepository {
  constructor(private readonly database: Database.Database) {}

  findArchive(userId: string): GameArchiveSummaryDto | null {
    const row = this.database.prepare(`SELECT ga.id AS archive_id, ga.user_id, ga.initial_funding_rule_version, ga.created_at AS archive_created_at,
      a.id AS account_id, a.currency, a.total_amount, a.available_amount, a.frozen_amount, a.updated_at
      FROM game_archives ga JOIN accounts a ON a.user_id = ga.user_id AND a.currency = 'GAME_CREDIT' WHERE ga.user_id = ?`).get(userId) as ArchiveRow | undefined;
    return row ? archiveSummary(row) : null;
  }

  createArchive(userId: string, ruleVersion: string, amount: number, now: string, correlationId: string): GameArchiveSummaryDto {
    assertPositiveMinorUnits(amount);
    const archiveId = randomUUID(); const accountId = randomUUID();
    this.database.prepare("INSERT INTO game_archives (id, user_id, initial_funding_rule_version, created_at) VALUES (?, ?, ?, ?)").run(archiveId, userId, ruleVersion, now);
    this.database.prepare("INSERT INTO accounts (id, user_id, currency, total_amount, available_amount, frozen_amount, updated_at) VALUES (?, ?, 'GAME_CREDIT', ?, ?, 0, ?)").run(accountId, userId, amount, amount, now);
    this.database.prepare("INSERT INTO ledger_entries (id, account_id, direction, amount, balance_after, reason, correlation_id, occurred_at) VALUES (?, ?, 'credit', ?, ?, 'initial_funding', ?, ?)").run(randomUUID(), accountId, amount, amount, correlationId, now);
    return this.findArchive(userId)!;
  }

  getBalance(userId: string): AccountBalanceDto | null {
    const row = this.database.prepare("SELECT id, user_id, currency, total_amount, available_amount, frozen_amount, updated_at FROM accounts WHERE user_id = ? AND currency = 'GAME_CREDIT'").get(userId) as AccountRow | undefined;
    return row ? balance(row) : null;
  }

  listLedger(userId: string, cursor: string | undefined, limit: number): Page<LedgerEntryDto> {
    const account = this.database.prepare("SELECT id FROM accounts WHERE user_id = ? AND currency = 'GAME_CREDIT'").get(userId) as { id: string } | undefined;
    if (!account) return { items: [], page: { nextCursor: null, hasMore: false } };
    const offset = cursor ? Number.parseInt(cursor, 10) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("账本分页游标无效");
    const rows = this.database.prepare(`SELECT l.id, a.user_id, l.direction, l.amount, l.balance_after, l.reason, l.correlation_id, l.occurred_at
      FROM ledger_entries l JOIN accounts a ON a.id = l.account_id WHERE l.account_id = ? ORDER BY l.occurred_at DESC, l.id DESC LIMIT ? OFFSET ?`).all(account.id, limit + 1, offset) as LedgerRow[];
    const hasMore = rows.length > limit; const visible = rows.slice(0, limit);
    return { items: visible.map((row) => ({ id: row.id, userId: row.user_id, direction: row.direction, amount: { amount: row.amount, currency: "GAME_CREDIT" }, balanceAfter: { amount: row.balance_after, currency: "GAME_CREDIT" }, reason: row.reason, correlationId: row.correlation_id, occurredAt: row.occurred_at })), page: { hasMore, nextCursor: hasMore ? String(offset + limit) : null } };
  }

  reserveFunds(userId: string, amount: number, target: FundHoldTarget, now: string): { holdId: string; balance: AccountBalanceDto } | "insufficient" {
    assertPositiveMinorUnits(amount);
    const account = this.accountForUpdate(userId);
    if (!account || account.available_amount < amount) return "insufficient";
    const changed = this.database.prepare("UPDATE accounts SET available_amount = available_amount - ?, frozen_amount = frozen_amount + ?, updated_at = ? WHERE id = ? AND available_amount >= ?").run(amount, amount, now, account.id, amount);
    if (changed.changes !== 1) return "insufficient";
    const holdId = randomUUID();
    this.database.prepare("INSERT INTO fund_holds (id, account_id, amount, reason, entity_type, entity_id, status, created_at, released_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL)").run(holdId, account.id, amount, target.reason, target.entityType, target.entityId, now);
    return { holdId, balance: this.getBalance(userId)! };
  }

  releaseFunds(userId: string, holdId: string, now: string): AccountBalanceDto | "not-active" {
    const hold = this.database.prepare("SELECT h.account_id, h.amount FROM fund_holds h JOIN accounts a ON a.id = h.account_id WHERE h.id = ? AND a.user_id = ? AND h.status = 'active'").get(holdId, userId) as { account_id: string; amount: number } | undefined;
    if (!hold) return "not-active";
    const changed = this.database.prepare("UPDATE fund_holds SET status = 'released', released_at = ? WHERE id = ? AND status = 'active'").run(now, holdId);
    if (changed.changes !== 1) return "not-active";
    this.database.prepare("UPDATE accounts SET available_amount = available_amount + ?, frozen_amount = frozen_amount - ?, updated_at = ? WHERE id = ?").run(hold.amount, hold.amount, now, hold.account_id);
    return this.getBalance(userId)!;
  }

  captureFunds(userId: string, holdId: string, now: string, correlationId: string): AccountBalanceDto | "not-active" {
    const hold = this.database.prepare("SELECT h.account_id, h.amount, h.reason FROM fund_holds h JOIN accounts a ON a.id = h.account_id WHERE h.id = ? AND a.user_id = ? AND h.status = 'active'").get(holdId, userId) as { account_id: string; amount: number; reason: string } | undefined;
    if (!hold) return "not-active";
    const changed = this.database.prepare("UPDATE fund_holds SET status = 'captured', released_at = ? WHERE id = ? AND status = 'active'").run(now, holdId);
    if (changed.changes !== 1) return "not-active";
    this.database.prepare("UPDATE accounts SET total_amount = total_amount - ?, frozen_amount = frozen_amount - ?, updated_at = ? WHERE id = ? AND frozen_amount >= ? AND total_amount >= ?").run(hold.amount, hold.amount, now, hold.account_id, hold.amount, hold.amount);
    const after = this.getBalance(userId)!;
    this.database.prepare("INSERT INTO ledger_entries (id, account_id, direction, amount, balance_after, reason, correlation_id, occurred_at) VALUES (?, ?, 'debit', ?, ?, ?, ?, ?)").run(randomUUID(), hold.account_id, hold.amount, after.total.amount, hold.reason, correlationId, now);
    return after;
  }

  writeAudit(actorId: string, action: string, entityType: string, entityId: string, requestId: string, summary: Record<string, unknown>, now: string): void {
    this.database.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, request_id, summary_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), actorId, action, entityType, entityId, requestId, JSON.stringify(summary), now);
  }

  private accountForUpdate(userId: string): AccountRow | undefined {
    return this.database.prepare("SELECT id, user_id, currency, total_amount, available_amount, frozen_amount, updated_at FROM accounts WHERE user_id = ? AND currency = 'GAME_CREDIT'").get(userId) as AccountRow | undefined;
  }
}
