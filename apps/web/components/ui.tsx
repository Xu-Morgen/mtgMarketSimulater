"use client";

import { useEffect, useRef } from "react";

export function PageSkeleton({ label }: { label: string }) { return <main className="page" aria-busy="true"><div className="skeleton title" /><div className="skeleton body" /><p className="sr-only">{label}</p></main>; }
export function ErrorState({ title = "加载失败", onRetry }: { title?: string; onRetry: () => void }) { return <section className="status-card" role="alert"><h2>{title}</h2><p>请检查网络连接后重试。</p><button className="button" type="button" onClick={onRetry}>重试</button></section>; }
export function EmptyState({ title, children }: Readonly<{ title: string; children: React.ReactNode }>) { return <section className="status-card"><h2>{title}</h2><p>{children}</p></section>; }
export function ExpiredHint() { return <p className="session-hint" role="status">会话已过期，请重新登录。</p>; }
export function ConfirmDialog({ open, title, description, onCancel, onConfirm }: { open: boolean; title: string; description: string; onCancel: () => void; onConfirm: () => void }) { const cancel = useRef<HTMLButtonElement>(null); useEffect(() => { if (open) cancel.current?.focus(); }, [open]); if (!open) return null; return <div className="dialog-backdrop" role="presentation"><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title"><h2 id="confirm-title">{title}</h2><p>{description}</p><div className="actions"><button ref={cancel} className="button secondary" onClick={onCancel}>取消</button><button className="button" onClick={onConfirm}>确认</button></div></section></div>; }
export function Pagination({ page, onPrevious, onNext, hasNext }: { page: number; onPrevious: () => void; onNext: () => void; hasNext: boolean }) { return <nav className="pagination" aria-label="分页"><button className="button secondary" disabled={page === 1} onClick={onPrevious}>上一页</button><span>第 {page} 页</span><button className="button secondary" disabled={!hasNext} onClick={onNext}>下一页</button></nav>; }
export function FilterBar({ children }: Readonly<{ children: React.ReactNode }>) { return <div className="filter-bar">{children}</div>; }
