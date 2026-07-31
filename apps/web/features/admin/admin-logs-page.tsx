"use client";

import type { AdminAuditLogDetailDto } from "@mtg-market/contracts";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { type AdminAuditLogFilters, useAdminAuditLogQuery, useAdminAuditLogsQuery } from "../../api/admin-api";
import { ApiClientError } from "../../api/client";
import { EmptyState, ErrorState, PageSkeleton } from "../../components/ui";
import { formatDateTime, summarizeSummary } from "./admin-format";
import styles from "./admin-shared.module.css";

const defaultLimit = 20;

function filtersFromSearch(search: URLSearchParams | null): AdminAuditLogFilters {
  const value = search ?? new URLSearchParams();
  const limit = Number.parseInt(value.get("limit") ?? "", 10);
  const filters: AdminAuditLogFilters = { limit: Number.isFinite(limit) && limit > 0 ? limit : defaultLimit };
  const cursor = value.get("cursor") || undefined;
  const from = value.get("from") || undefined;
  const to = value.get("to") || undefined;
  const actorId = value.get("actorId") || undefined;
  const userId = value.get("userId") || undefined;
  const entityType = value.get("entityType") || undefined;
  const entityId = value.get("entityId") || undefined;
  const action = value.get("action") || undefined;
  const requestId = value.get("requestId") || undefined;
  const taskType = value.get("taskType") || undefined;
  if (cursor) filters.cursor = cursor;
  if (from) filters.from = from;
  if (to) filters.to = to;
  if (actorId) filters.actorId = actorId;
  if (userId) filters.userId = userId;
  if (entityType) filters.entityType = entityType;
  if (entityId) filters.entityId = entityId;
  if (action) filters.action = action;
  if (requestId) filters.requestId = requestId;
  if (taskType) filters.taskType = taskType;
  return filters;
}

function toUrl(filters: AdminAuditLogFilters): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value && !(key === "limit" && value === defaultLimit)) search.set(key, String(value));
  }
  const suffix = search.toString();
  return suffix ? `/admin/logs?${suffix}` : "/admin/logs";
}

/** 返回清空 cursor 的筛选，避免 exactOptionalPropertyTypes 下显式 undefined。 */
function withClearedCursor(filters: AdminAuditLogFilters): AdminAuditLogFilters {
  const next: AdminAuditLogFilters = {};
  if (filters.limit !== undefined) next.limit = filters.limit;
  for (const [key, value] of Object.entries(filters)) {
    if (key === "cursor" || key === "limit") continue;
    if (value !== undefined) (next as Record<string, string | number>)[key] = value;
  }
  return next;
}

/** I30F 审计日志页：服务端分页 + 脱敏详情 + 关联记录；只读，不提供删除或修改。 */
export function AdminLogsPage() {
  const router = useRouter();
  const search = useSearchParams();
  const filters = filtersFromSearch(search);
  const logs = useAdminAuditLogsQuery(filters);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  if (logs.isPending) return <PageSkeleton label="正在加载审计日志" />;
  if (logs.isError) return <main className="page"><ErrorState title={logs.error instanceof ApiClientError && logs.error.code === "AUTHORIZATION_DENIED" ? "无权查看审计日志" : "审计日志加载失败"} onRetry={() => void logs.refetch()} /></main>;
  if (!logs.data) return <PageSkeleton label="正在确认审计日志访问权限" />;
  const page = logs.data.data;
  const hasNext = page.page.hasMore;
  const hasPrev = Boolean(filters.cursor);
  const goPrev = () => router.push(toUrl(withClearedCursor(filters)));
  const goNext = () => { if (page.page.nextCursor) router.push(toUrl({ ...withClearedCursor(filters), cursor: page.page.nextCursor })); };
  const applyFilters = (next: AdminAuditLogFilters) => router.push(toUrl(withClearedCursor(next)));
  return <main className={`page ${styles.page}`}>
    <h1>审计日志</h1>
    <p className={styles.intro}>只读、服务端分页的不可变审计日志；支持按时间、操作者、用户、实体、动作、请求 ID 和任务类型筛选。详情显示脱敏摘要与关联记录，不暴露密码、令牌、Cookie 或 Provider 原文。</p>
    <LogFilters initial={filters} onApply={applyFilters} />
    {page.items.length === 0 ? <EmptyState title="没有匹配的审计日志">当前筛选下没有服务端记录。调整筛选条件或清除后重试。</EmptyState> : <div className={styles.tableWrap}><table><thead><tr><th>时间</th><th>动作</th><th>操作者</th><th>实体</th><th>请求 ID</th><th>操作</th></tr></thead><tbody>
      {page.items.map((log) => <tr key={log.id}>
        <td>{formatDateTime(log.occurredAt)}</td>
        <td>{log.action}</td>
        <td className={styles.mono}>{log.actorId ?? "系统"}</td>
        <td className={styles.mono}>{log.entityType} · {log.entityId}</td>
        <td className={styles.mono}>{log.requestId ?? "—"}</td>
        <td><button className="button secondary" type="button" onClick={() => setSelectedId(log.id)}>查看详情</button></td>
      </tr>)}
    </tbody></table></div>}
    <nav className="pagination" aria-label="日志分页">
      <button className="button secondary" disabled={!hasPrev} onClick={goPrev}>首页</button>
      <button className="button secondary" disabled={!hasNext} onClick={goNext}>下一页</button>
    </nav>
    {selectedId ? <LogDetailDialog id={selectedId} onClose={() => setSelectedId(null)} /> : null}
  </main>;
}

function LogFilters({ initial, onApply }: { initial: AdminAuditLogFilters; onApply: (filters: AdminAuditLogFilters) => void }) {
  const [from, setFrom] = useState(initial.from ?? "");
  const [to, setTo] = useState(initial.to ?? "");
  const [actorId, setActorId] = useState(initial.actorId ?? "");
  const [userId, setUserId] = useState(initial.userId ?? "");
  const [entityType, setEntityType] = useState(initial.entityType ?? "");
  const [action, setAction] = useState(initial.action ?? "");
  const [requestId, setRequestId] = useState(initial.requestId ?? "");
  const submit = () => {
    const next: AdminAuditLogFilters = { limit: defaultLimit };
    if (from) next.from = from;
    if (to) next.to = to;
    if (actorId) next.actorId = actorId;
    if (userId) next.userId = userId;
    if (entityType) next.entityType = entityType;
    if (action) next.action = action;
    if (requestId) next.requestId = requestId;
    onApply(next);
  };
  const reset = () => { setFrom(""); setTo(""); setActorId(""); setUserId(""); setEntityType(""); setAction(""); setRequestId(""); onApply({ limit: defaultLimit }); };
  return <div className={styles.filterGrid}>
    <label>开始时间（UTC）<input type="datetime-local" aria-label="开始时间" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
    <label>结束时间（UTC）<input type="datetime-local" aria-label="结束时间" value={to} onChange={(event) => setTo(event.target.value)} /></label>
    <label>操作者 ID<input aria-label="操作者 ID" value={actorId} onChange={(event) => setActorId(event.target.value)} placeholder="可选 UUID" /></label>
    <label>用户 ID<input aria-label="用户 ID" value={userId} onChange={(event) => setUserId(event.target.value)} placeholder="可选 UUID" /></label>
    <label>实体类型<input aria-label="实体类型" value={entityType} onChange={(event) => setEntityType(event.target.value)} placeholder="例如 campaign、user" /></label>
    <label>动作关键字<input aria-label="动作关键字" value={action} onChange={(event) => setAction(event.target.value)} placeholder="例如 campaign.published" /></label>
    <label>请求 ID<input aria-label="请求 ID" value={requestId} onChange={(event) => setRequestId(event.target.value)} placeholder="可选请求 ID" /></label>
    <div className={styles.actions}><button className="button" type="button" onClick={submit}>应用筛选</button><button className="button secondary" type="button" onClick={reset}>清除筛选</button></div>
  </div>;
}

function LogDetailDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const detail = useAdminAuditLogQuery(id);
  return <div className="dialog-backdrop" role="presentation">
    <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="audit-log-title">
      <h2 id="audit-log-title">审计日志详情</h2>
      {detail.isPending ? <p>正在加载详情…</p> : detail.isError ? <p className={styles.failure}>详情加载失败，请关闭后重试。</p> : <LogDetailBody log={detail.data!.data.log} />}
      <div className="actions"><button className="button secondary" type="button" onClick={onClose}>关闭</button></div>
    </section>
  </div>;
}

function LogDetailBody({ log }: { log: AdminAuditLogDetailDto }) {
  return <>
    <dl className={styles.details}>
      <div><dt>日志 ID</dt><dd className={styles.mono}>{log.id}</dd></div>
      <div><dt>时间</dt><dd>{formatDateTime(log.occurredAt)}</dd></div>
      <div><dt>动作</dt><dd>{log.action}</dd></div>
      <div><dt>实体</dt><dd className={styles.mono}>{log.entityType} · {log.entityId}</dd></div>
      <div><dt>操作者</dt><dd className={styles.mono}>{log.actorId ?? "系统"}</dd></div>
      <div><dt>请求 ID</dt><dd className={styles.mono}>{log.requestId ?? "—"}</dd></div>
    </dl>
    <section className={styles.notice} aria-label="脱敏摘要">
      <h3>脱敏摘要</h3>
      <pre className={styles.summary}>{summarizeSummary(log.summary)}</pre>
      <p>敏感字段（密码、令牌、Cookie、密钥、Provider 原文）已在写入方剔除；本页不提供修改或删除入口。</p>
    </section>
    <section className={styles.notice} aria-label="关联记录">
      <h3>关联记录</h3>
      {log.relatedLogs.length === 0 ? <p>没有近期同实体记录。</p> : <div className={styles.tableWrap}><table><thead><tr><th>时间</th><th>动作</th><th>请求 ID</th></tr></thead><tbody>
        {log.relatedLogs.map((entry) => <tr key={entry.id}><td>{formatDateTime(entry.occurredAt)}</td><td>{entry.action}</td><td className={styles.mono}>{entry.requestId ?? "—"}</td></tr>)}
      </tbody></table></div>}
    </section>
  </>;
}
