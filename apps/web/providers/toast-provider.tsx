"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
type Toast = { id: number; message: string; tone: "success" | "error" };
const ToastContext = createContext<{ showToast: (message: string, tone?: Toast["tone"]) => void } | null>(null);
export function ToastProvider({ children }: Readonly<{ children: React.ReactNode }>) { const [toasts, setToasts] = useState<Toast[]>([]); const showToast = useCallback((message: string, tone: Toast["tone"] = "success") => { const id = Date.now(); setToasts((items) => [...items, { id, message, tone }]); window.setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), 4500); }, []); const value = useMemo(() => ({ showToast }), [showToast]); return <ToastContext.Provider value={value}>{children}<div className="toast-region" aria-live="polite">{toasts.map((toast) => <p className={`toast toast-${toast.tone}`} key={toast.id}>{toast.message}</p>)}</div></ToastContext.Provider>; }
export function useToast() { const context = useContext(ToastContext); if (!context) throw new Error("useToast 必须在 ToastProvider 内使用"); return context; }
