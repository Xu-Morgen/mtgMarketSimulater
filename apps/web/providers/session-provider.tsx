"use client";

import type { UserDto } from "@mtg-market/contracts";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { authApi, ApiClientError, type SessionPayload } from "../api/client";
import { readCookie } from "../utils/cookies";

type SessionStatus = "recovering" | "authenticated" | "anonymous" | "expired";
interface SessionContextValue { status: SessionStatus; user: UserDto | null; accessToken: string | null; csrfToken: string | null; acceptSession: (session: SessionPayload) => void; clearSession: () => void; }
const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: Readonly<{ children: React.ReactNode }>) {
  const [status, setStatus] = useState<SessionStatus>("recovering"); const [user, setUser] = useState<UserDto | null>(null); const [accessToken, setAccessToken] = useState<string | null>(null); const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const clearSession = useCallback(() => { setUser(null); setAccessToken(null); setCsrfToken(null); setStatus("anonymous"); }, []);
  const acceptSession = useCallback((session: SessionPayload) => { setUser(session.user); setAccessToken(session.accessToken); setCsrfToken(readCookie("mtg_csrf")); setStatus("authenticated"); }, []);
  useEffect(() => { const csrf = readCookie("mtg_csrf"); if (!csrf) { setStatus("anonymous"); return; } authApi.refresh(csrf).then(({ data }) => acceptSession(data)).catch((error: unknown) => { setUser(null); setAccessToken(null); setCsrfToken(null); setStatus(error instanceof ApiClientError ? "expired" : "anonymous"); }); }, [acceptSession]);
  const value = useMemo(() => ({ status, user, accessToken, csrfToken, acceptSession, clearSession }), [status, user, accessToken, csrfToken, acceptSession, clearSession]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
export function useSession(): SessionContextValue { const value = useContext(SessionContext); if (!value) throw new Error("useSession 必须在 SessionProvider 内使用"); return value; }
export function useRedirectToLogin() { const router = useRouter(); return useCallback(() => router.replace("/login"), [router]); }
