"use client";

import type { LedgerEntryDto } from "@mtg-market/contracts";
import { useState } from "react";
import { ApiClientError } from "../../api/client";
import { useArchiveQuery, useCreateArchiveMutation, useLedgerQuery } from "../../api/archive-api";
import { EmptyState, ErrorState, PageSkeleton, Pagination } from "../../components/ui";
import { formatMoney } from "../../utils/money";

function LedgerTable({ entries }: { entries: LedgerEntryDto[] }) {
  if (entries.length === 0) return <EmptyState title="暂无账本流水">后续资金变动会由服务器记录在这里。</EmptyState>;
  return <div className="ledger-table" role="region" aria-label="账本流水" tabIndex={0}>
    <table>
      <thead><tr><th>时间</th><th>类型</th><th>金额</th><th>变更后余额</th></tr></thead>
      <tbody>{entries.map((entry) => <tr key={entry.id}><td>{new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(new Date(entry.occurredAt))}</td><td>{entry.reason === "initial_funding" ? "初始资金" : entry.reason}</td><td className={entry.direction === "credit" ? "credit" : "debit"}>{entry.direction === "credit" ? "+" : "-"}{formatMoney(entry.amount)}</td><td>{formatMoney(entry.balanceAfter)}</td></tr>)}</tbody>
    </table>
  </div>;
}

export function PlayerDashboardPage() {
  const archive = useArchiveQuery();
  const createArchive = useCreateArchiveMutation();
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1) ?? null;
  const hasArchive = archive.isSuccess;
  const ledger = useLedgerQuery(cursor, hasArchive);

  if (archive.isPending) return <PageSkeleton label="正在加载玩家存档" />;
  if (archive.isError && !(archive.error instanceof ApiClientError && archive.error.code === "RESOURCE_NOT_FOUND")) return <main className="page"><ErrorState title="存档加载失败" onRetry={() => void archive.refetch()} /></main>;
  if (!hasArchive) return <main className="page"><p className="eyebrow">玩家首页</p><h1>开始你的市场之旅</h1><EmptyState title="尚未创建游戏存档">创建后，服务器会初始化你的账户和初始资金。</EmptyState><div className="actions"><button className="button" type="button" onClick={() => createArchive.mutate()} disabled={createArchive.isPending}>{createArchive.isPending ? "正在创建存档…" : "创建游戏存档"}</button></div>{createArchive.isError ? <p className="form-error" role="alert">{createArchive.error instanceof Error ? createArchive.error.message : "创建存档失败，请重试。"}</p> : null}</main>;

  const data = archive.data.data.archive;
  const ledgerData = ledger.data?.data;
  return <main className="page dashboard-page"><p className="eyebrow">玩家首页</p><h1>账户概览</h1><p className="intro">以下余额与账本均由服务器返回，金额以游戏币最小单位展示。</p>
    <section className="balance-grid" aria-label="账户余额">
      <article><span>总额</span><strong>{formatMoney(data.balance.total)}</strong></article>
      <article><span>可用额</span><strong>{formatMoney(data.balance.available)}</strong></article>
      <article><span>冻结额</span><strong>{formatMoney(data.balance.frozen)}</strong></article>
      <article><span>净资产</span><strong>{data.netWorth ? formatMoney(data.netWorth) : "暂不可用"}</strong><small>库存估值将在后续版本提供</small></article>
    </section>
    <section className="dashboard-section"><h2>账本流水</h2>{ledger.isPending ? <PageSkeleton label="正在加载账本流水" /> : ledger.isError ? <ErrorState title="账本加载失败" onRetry={() => void ledger.refetch()} /> : <><LedgerTable entries={ledgerData?.items ?? []} /><Pagination page={cursors.length + 1} onPrevious={() => setCursors((items) => items.slice(0, -1))} onNext={() => { if (ledgerData?.page.nextCursor) setCursors((items) => [...items, ledgerData.page.nextCursor!]); }} hasNext={ledgerData?.page.hasMore ?? false} /></>}</section>
    <section className="dashboard-section"><h2>下一步</h2><EmptyState title="市场功能即将开放">后续迭代将在这里提供补充包、目录与交易入口。</EmptyState></section>
  </main>;
}
