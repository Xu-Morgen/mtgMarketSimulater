"use client";

import type { Role } from "@mtg-market/contracts";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useSession } from "../providers/session-provider";
import { ExpiredHint, PageSkeleton } from "./ui";

export function SessionGate({ allowedRoles, children }: Readonly<{ allowedRoles: Role[]; children: React.ReactNode }>) {
  const session = useSession(); const router = useRouter(); const pathname = usePathname();
  useEffect(() => { if (session.status === "anonymous" || session.status === "expired") router.replace(`/login?next=${encodeURIComponent(pathname ?? "/")}`); else if (session.status === "authenticated" && session.user && !allowedRoles.includes(session.user.role)) router.replace("/forbidden"); }, [allowedRoles, pathname, router, session.status, session.user]);
  if (session.status === "recovering") return <PageSkeleton label="正在恢复会话" />;
  if (session.status === "expired") return <main className="page"><ExpiredHint /></main>;
  if (session.status !== "authenticated" || !session.user || !allowedRoles.includes(session.user.role)) return <PageSkeleton label="正在确认访问权限" />;
  return <>{children}</>;
}
