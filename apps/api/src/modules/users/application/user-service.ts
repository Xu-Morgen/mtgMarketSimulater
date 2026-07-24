import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { canonicalizeRequest, type ApiResponse, type GameArchiveSummaryDto } from "@mtg-market/contracts";
import { INITIAL_FUNDING_RULE_VERSION, resolveInitialFunding } from "@mtg-market/rules";
import { withinTransaction } from "@mtg-market/database";
import { SqliteUserRepository } from "../infrastructure/sqlite-user-repository.js";
import { success } from "../../../shared/http/api-response.js";

export type ArchiveCreationResult =
  | { state: "created"; response: ApiResponse<{ archive: GameArchiveSummaryDto }> }
  | { state: "replayed"; response: ApiResponse<{ archive: GameArchiveSummaryDto }> }
  | { state: "conflict" }
  | { state: "in-progress" };

/** 存档用例：同一短事务内创建存档、账户、初始账本和业务审计，并持久化幂等响应。 */
export class UserService {
  private readonly users: SqliteUserRepository;
  constructor(private readonly database: Database.Database) { this.users = new SqliteUserRepository(database); }

  createArchive(input: { userId: string; idempotencyKey: string; requestFingerprint: string; requestId: string; now?: Date }): ArchiveCreationResult {
    const now = (input.now ?? new Date()).toISOString();
    return withinTransaction(this.database, () => {
      const existing = this.database.prepare("SELECT request_fingerprint, status, response_json FROM idempotency_requests WHERE actor_id = ? AND idempotency_key = ?").get(input.userId, input.idempotencyKey) as { request_fingerprint: string; status: string; response_json: string | null } | undefined;
      if (existing) return this.idempotencyResult(existing, input.requestFingerprint);
      try {
        this.database.prepare("INSERT INTO idempotency_requests (id, actor_id, idempotency_key, request_fingerprint, status, response_status, response_json, created_at, completed_at) VALUES (?, ?, ?, ?, 'running', NULL, NULL, ?, NULL)").run(randomUUID(), input.userId, input.idempotencyKey, input.requestFingerprint, now);
      } catch {
        const raced = this.database.prepare("SELECT request_fingerprint, status, response_json FROM idempotency_requests WHERE actor_id = ? AND idempotency_key = ?").get(input.userId, input.idempotencyKey) as { request_fingerprint: string; status: string; response_json: string | null } | undefined;
        return raced ? this.idempotencyResult(raced, input.requestFingerprint) : { state: "in-progress" };
      }

      const existingArchive = this.users.findArchive(input.userId);
      const archive = existingArchive ?? this.users.createArchive(input.userId, INITIAL_FUNDING_RULE_VERSION, resolveInitialFunding(INITIAL_FUNDING_RULE_VERSION).amount, now, `archive:${input.userId}`);
      if (!existingArchive) {
        this.users.writeAudit(input.userId, "archive.created", "game_archive", archive.id, input.requestId, { initialFundingRuleVersion: archive.initialFundingRuleVersion, initialAmount: archive.balance.total.amount }, now);
      }
      const response = success(input.requestId, { archive });
      this.database.prepare("UPDATE idempotency_requests SET status = 'completed', response_status = 201, response_json = ?, completed_at = ? WHERE actor_id = ? AND idempotency_key = ? AND status = 'running'").run(JSON.stringify(response), now, input.userId, input.idempotencyKey);
      return { state: "created", response };
    });
  }

  archive(userId: string): GameArchiveSummaryDto | null { return this.users.findArchive(userId); }
  balance(userId: string) { return this.users.getBalance(userId); }
  ledger(userId: string, cursor: string | undefined, limit: number) { return this.users.listLedger(userId, cursor, limit); }
  funds(): SqliteUserRepository { return this.users; }

  private idempotencyResult(existing: { request_fingerprint: string; status: string; response_json: string | null }, fingerprint: string): ArchiveCreationResult {
    if (existing.request_fingerprint !== fingerprint) return { state: "conflict" };
    if (existing.status !== "completed" || !existing.response_json) return { state: "in-progress" };
    return { state: "replayed", response: JSON.parse(existing.response_json) as ApiResponse<{ archive: GameArchiveSummaryDto }> };
  }
}

export function archiveRequestFingerprint(body: unknown): string {
  return createHash("sha256").update(canonicalizeRequest(body)).digest("hex");
}
