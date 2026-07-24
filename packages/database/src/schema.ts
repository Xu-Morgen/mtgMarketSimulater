import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** SQLite 持久化事实模型。金额字段均为整数最小货币单位，时间均为 UTC ISO 8601。 */
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull().default("player"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [uniqueIndex("users_email_unique").on(table.email)]
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    refreshTokenHash: text("refresh_token_hash").notNull(),
    /** 双提交 CSRF token 的摘要；原文只通过非 HttpOnly Cookie 交付浏览器。 */
    csrfTokenHash: text("csrf_token_hash"),
    expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull(),
    /** 轮换链用于 refresh token 重放时撤销其后续派生会话。 */
    rotatedFromSessionId: text("rotated_from_session_id")
  },
  (table) => [index("sessions_user_id_index").on(table.userId)]
);

export const idempotencyRequests = sqliteTable(
  "idempotency_requests",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    status: text("status").notNull(),
    responseStatus: integer("response_status"),
    responseJson: text("response_json"),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at")
  },
  (table) => [uniqueIndex("idempotency_actor_key_unique").on(table.actorId, table.idempotencyKey)]
);

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    currency: text("currency").notNull(),
    totalAmount: integer("total_amount").notNull(),
    availableAmount: integer("available_amount").notNull(),
    frozenAmount: integer("frozen_amount").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [uniqueIndex("accounts_user_currency_unique").on(table.userId, table.currency)]
);

export const ledgerEntries = sqliteTable(
  "ledger_entries",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull().references(() => accounts.id),
    direction: text("direction").notNull(),
    amount: integer("amount").notNull(),
    balanceAfter: integer("balance_after").notNull(),
    reason: text("reason").notNull(),
    correlationId: text("correlation_id").notNull(),
    occurredAt: text("occurred_at").notNull()
  },
  (table) => [index("ledger_entries_account_occurred_index").on(table.accountId, table.occurredAt)]
);

export const fundHolds = sqliteTable(
  "fund_holds",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull().references(() => accounts.id),
    amount: integer("amount").notNull(),
    reason: text("reason").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    releasedAt: text("released_at")
  },
  (table) => [index("fund_holds_account_status_index").on(table.accountId, table.status)]
);

export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    requestId: text("request_id"),
    summaryJson: text("summary_json").notNull(),
    occurredAt: text("occurred_at").notNull()
  },
  (table) => [index("audit_logs_entity_index").on(table.entityType, table.entityId)]
);

export const factEvents = sqliteTable(
  "fact_events",
  {
    id: text("id").primaryKey(),
    eventType: text("event_type").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    version: integer("version").notNull(),
    payloadJson: text("payload_json").notNull(),
    occurredAt: text("occurred_at").notNull()
  },
  (table) => [uniqueIndex("fact_events_aggregate_version_unique").on(table.aggregateType, table.aggregateId, table.version)]
);

export const outbox = sqliteTable(
  "outbox",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull().references(() => factEvents.id),
    destination: text("destination").notNull(),
    payloadJson: text("payload_json").notNull(),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    dispatchedAt: text("dispatched_at")
  },
  (table) => [uniqueIndex("outbox_event_destination_unique").on(table.eventId, table.destination)]
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull(),
    status: text("status").notNull(),
    runAfter: text("run_after").notNull(),
    attempts: integer("attempts").notNull(),
    maxAttempts: integer("max_attempts").notNull(),
    uniqueKey: text("unique_key").notNull(),
    lockedUntil: text("locked_until"),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [uniqueIndex("jobs_type_unique_key_unique").on(table.type, table.uniqueKey)]
);

/** 每次领取均留下不可变运行记录；重试会创建新的 attempt，而不会覆盖历史错误。 */
export const jobRuns = sqliteTable(
  "job_runs",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull().references(() => jobs.id),
    attempt: integer("attempt").notNull(),
    status: text("status").notNull(),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    errorSummary: text("error_summary")
  },
  (table) => [uniqueIndex("job_runs_job_attempt_unique").on(table.jobId, table.attempt), index("job_runs_job_started_index").on(table.jobId, table.startedAt)]
);

export const ruleVersions = sqliteTable(
  "rule_versions",
  {
    id: text("id").primaryKey(),
    ruleSet: text("rule_set").notNull(),
    version: text("version").notNull(),
    definitionJson: text("definition_json").notNull(),
    activatedAt: text("activated_at").notNull(),
    retiredAt: text("retired_at")
  },
  (table) => [uniqueIndex("rule_versions_set_version_unique").on(table.ruleSet, table.version)]
);
