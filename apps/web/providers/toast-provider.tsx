"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
type Toast = { id: number; message: string; tone: "success" | "error" };
const ToastContext = createContext<{ showToast: (message: string, tone?: Toast["tone"]) => void } | null>(null);

/** Toast 装饰图标：原创 stroke 内联 SVG（aria-hidden，不改变朗读内容）。 */
function ToastIcon({ tone }: { tone: Toast["tone"] }) {
  const common = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (tone === "success") return <svg {...common}><path d="M12 3l2.2 5.6L20 9l-4.4 3.8L17 19l-5-3.2L7 19l1.4-6.2L4 9l5.8-.4L12 3Z" /></svg>;
  return <svg {...common}><path d="M12 9v4M12 16.5v.5M12 3l8 3v5c0 5-3.4 8.4-8 10-4.6-1.6-8-5-8-10V6l8-3Z" /></svg>;
}

export function ToastProvider({ children }: Readonly<{ children: React.ReactNode }>) { const [toasts, setToasts] = useState<Toast[]>([]); const showToast = useCallback((message: string, tone: Toast["tone"] = "success") => { const id = Date.now(); setToasts((items) => [...items, { id, message, tone }]); window.setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), 4500); }, []); const value = useMemo(() => ({ showToast }), [showToast]); return <ToastContext.Provider value={value}>{children}<div className="toast-region" aria-live="polite">{toasts.map((toast) => <p className={`toast toast-${toast.tone}`} key={toast.id}><ToastIcon tone={toast.tone} />{toast.message}</p>)}</div></ToastContext.Provider>; }
export function useToast() { const context = useContext(ToastContext); if (!context) throw new Error("useToast 必须在 ToastProvider 内使用"); return context; }
