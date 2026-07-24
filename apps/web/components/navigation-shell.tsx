"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLogoutMutation } from "../api/auth-mutations";
import { useSession } from "../providers/session-provider";

function SignOutButton() { const router = useRouter(); const logout = useLogoutMutation(); return <button className="text-button" disabled={logout.isPending} onClick={() => logout.mutate(undefined, { onSuccess: () => router.replace("/login") })}>{logout.isPending ? "正在退出…" : "退出登录"}</button>; }
function Shell({ children, admin }: Readonly<{ children: React.ReactNode; admin: boolean }>) { const { user } = useSession(); const links: Array<{ href: string; label: string }> = admin ? [{ href: "/admin", label: "后台首页" }, { href: "/admin/catalog-sync", label: "目录同步" }, { href: "/admin/content", label: "内容" }, { href: "/admin/events", label: "活动" }, { href: "/admin/users", label: "玩家" }, { href: "/admin/jobs", label: "任务" }, { href: "/admin/logs", label: "日志" }] : [{ href: "/dashboard", label: "玩家首页" }, { href: "/catalog", label: "卡牌目录" }, { href: "/inventory", label: "我的库存" }]; return <div className="app-shell"><header className="topbar"><Link href={admin ? "/admin" : "/dashboard"} className="brand">MTG 市场模拟器</Link><span className="user-label">{user?.displayName} · {admin ? "管理员" : "玩家"}</span><SignOutButton /></header><div className="shell-body"><nav className="side-nav" aria-label={admin ? "管理导航" : "玩家导航"}>{links.map(({ href, label }) => <Link href={href} key={href}>{label}</Link>)}</nav><main className="content">{children}</main></div></div>; }
export function PlayerShell({ children }: Readonly<{ children: React.ReactNode }>) { return <Shell admin={false}>{children}</Shell>; }
export function AdminShell({ children }: Readonly<{ children: React.ReactNode }>) { return <Shell admin>{children}</Shell>; }
