"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useLogoutMutation } from "../api/auth-mutations";
import { useArchiveQuery } from "../api/archive-api";
import { useDailyWorkFundingStatusQuery } from "../api/daily-work-funding-api";
import { useSession } from "../providers/session-provider";
import { formatMoney } from "../utils/money";
import { OnboardingGuideTour } from "./onboarding-guide-tour";

/** 宝石徽章图标：原创内联 SVG（stroke 风格），不用 emoji。 */
function GemIcon({ size = 14 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 3h12l4 6-10 12L2 9l4-6Z" />
    <path d="M2 9h20M8.5 3 6 9l6 12M15.5 3 18 9l-6 12" />
  </svg>;
}

function CoinIcon({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="4.5" />
    <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
  </svg>;
}

/** 侧栏导航图标：原创 stroke 风格内联 SVG（aria-hidden，不贡献可访问名）。 */
function NavIcon({ kind, size = 15 }: { kind: string; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (kind) {
    case "dashboard": // 菱形徽记（大厅）
      return <svg {...common}><path d="M6 3h12l4 6-10 12L2 9l4-6Z" /><path d="M2 9h20M8.5 3 6 9l6 12M15.5 3 18 9l-6 12" /></svg>;
    case "collection": // 书册（收藏册）
      return <svg {...common}><path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5Z" /><path d="M4 9h16M8 5v14" /></svg>;
    case "catalog": // 展开的卡册（目录）
      return <svg {...common}><rect x="4" y="3" width="6" height="9" rx="1" /><rect x="14" y="3" width="6" height="9" rx="1" /><rect x="6" y="16" width="6" height="5" rx="1" /><rect x="16" y="14" width="4" height="4" rx="1" /><path d="M4 15h6" /></svg>;
    case "market": // 天平（市场）
      return <svg {...common}><path d="M12 3v18M7 21h10M12 6l-5 7M12 6l5 7" /><path d="M7 13h10" /></svg>;
    case "history": // 曲线（价格历史）
      return <svg {...common}><path d="M3 17l6-6 4 4 8-9" /><path d="M17 6h4v4" /></svg>;
    case "orders": // 羊皮卷（委托）
      return <svg {...common}><path d="M5 3h14v18H5z" /><path d="M9 8h6M9 12h6M9 16h4" /></svg>;
    case "watchlist": // 铃铛（价格提醒）
      return <svg {...common}><path d="M12 3a5 5 0 0 0-5 5v3L5 15v2h14v-2l-2-4V8a5 5 0 0 0-5-5Z" /><path d="M10 20a2 2 0 0 0 4 0" /></svg>;
    case "packs": // 包体（补充包）
      return <svg {...common}><rect x="4" y="6" width="16" height="12" rx="2" /><path d="M4 10h16M12 6v12" /><circle cx="12" cy="13" r="1.6" /></svg>;
    case "inventory": // 货箱（库存）
      return <svg {...common}><path d="M3 8l9-5 9 5v8l-9 5-9-5V8Z" /><path d="M3 8l9 5 9-5M12 13v8" /></svg>;
    case "decks": // 剑盾（卡组）
      return <svg {...common}><path d="M12 3c4 2 6 6 6 10H6c0-4 2-8 6-10Z" /><path d="M12 13v8M7 17h10" /></svg>;
    case "tournaments": // 奖杯（比赛）
      return <svg {...common}><path d="M8 4h8v6a4 4 0 0 1-8 0V4Z" /><path d="M8 5H4a0 0 0 0 0 0v1a4 4 0 0 0 4 4M16 5h4a0 0 0 0 1 0 0v1a4 4 0 0 1-4 4M12 14v4M9 21h6M10 18h4" /></svg>;
    case "achievements": // 星辰（成就）
      return <svg {...common}><path d="M12 3l2.2 5.6L20 9l-4.4 3.8L17 19l-5-3.2L7 19l1.4-6.2L4 9l5.8-.4L12 3Z" /></svg>;
    case "tasks": // 任务清单（任务中心）
      return <svg {...common}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 9h8M8 13h8M8 17h5" /><path d="M9 6.5l2 2 4-4" /></svg>;
    case "onboarding": // 罗盘（新手引导）
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /><path d="M15.5 8.5 13 13l-4.5 2.5L11 11l4.5-2.5Z" /></svg>;
    case "exports": // 下载（导出）
      return <svg {...common}><path d="M12 3v11M8 10l4 4 4-4M4 17v3h16v-3" /></svg>;
    case "admin": // 权杖（后台）
      return <svg {...common}><path d="M12 3l2 4 4 2-4 2-2 4-2-4-4-2 4-2 2-4Z" /><path d="M6 19h12" /></svg>;
    case "sync": // 循环（同步）
      return <svg {...common}><path d="M20 12a8 8 0 1 1-2.3-5.6" /><path d="M20 4v4h-4" /></svg>;
    case "risk": // 警戒盾（异常订单）
      return <svg {...common}><path d="M12 3l8 3v5c0 5-3.4 8.4-8 10-4.6-1.6-8-5-8-10V6l8-3Z" /><path d="M12 9v4M12 16.5v.5" /></svg>;
    case "content": // 齿轮（内容）
      return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" /></svg>;
    case "events": // 旗帜（活动）
      return <svg {...common}><path d="M4 21V4M4 6h14l-3 4 3 4H4" /></svg>;
    case "users": // 人像（玩家）
      return <svg {...common}><circle cx="9" cy="8" r="3.5" /><path d="M3 20a6 6 0 0 1 12 0M16 4.5a3.5 3.5 0 0 1 0 7M15.5 15a6 6 0 0 1 5 5" /></svg>;
    case "jobs": // 时钟（任务）
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></svg>;
    case "backups": // 档案盒（备份）
      return <svg {...common}><rect x="3" y="4" width="18" height="6" rx="1" /><path d="M5 10v10h14V10M8 14h8" /></svg>;
    case "logs": // 日志页
      return <svg {...common}><path d="M4 4h16v16H4z" /><path d="M4 9h16M8 13h8M8 16h5" /></svg>;
    default: // 宝石兜底
      return <svg {...common}><path d="M6 3h12l4 6-10 12L2 9l4-6Z" /><path d="M2 9h20M8.5 3 6 9l6 12M15.5 3 18 9l-6 12" /></svg>;
  }
}

function SignOutButton() {
  const router = useRouter();
  const logout = useLogoutMutation();
  return <button className="text-button" disabled={logout.isPending} onClick={() => logout.mutate(undefined, { onSuccess: () => router.replace("/login") })}>{logout.isPending ? "正在退出…" : "退出登录"}</button>;
}

type NavLink = { href: string; label: string; icon?: string };
type NavGroup = { title: string; links: NavLink[] };

const playerGroups: NavGroup[] = [
  { title: "大厅", links: [{ href: "/dashboard", label: "玩家首页", icon: "dashboard" }, { href: "/onboarding", label: "新手引导", icon: "onboarding" }, { href: "/collection", label: "收藏册", icon: "collection" }, { href: "/collection/album", label: "收藏图鉴", icon: "collection" }] },
  { title: "市场", links: [{ href: "/catalog", label: "卡牌目录", icon: "catalog" }, { href: "/market", label: "市场", icon: "market" }, { href: "/market/history", label: "价格历史", icon: "history" }, { href: "/orders", label: "我的委托", icon: "orders" }, { href: "/watchlist", label: "价格提醒", icon: "watchlist" }] },
  { title: "卡牌经营", links: [{ href: "/packs", label: "补充包商店", icon: "packs" }, { href: "/inventory", label: "我的库存", icon: "inventory" }, { href: "/decks", label: "我的卡组", icon: "decks" }] },
  { title: "赛事与成长", links: [{ href: "/tournaments", label: "比赛", icon: "tournaments" }, { href: "/tasks", label: "任务中心", icon: "tasks" }, { href: "/achievements", label: "成就", icon: "achievements" }] },
  { title: "数据", links: [{ href: "/exports", label: "我的数据导出", icon: "exports" }] }
];

const adminGroups: NavGroup[] = [
  { title: "总览", links: [{ href: "/admin", label: "后台首页", icon: "admin" }] },
  { title: "同步", links: [{ href: "/admin/catalog-sync", label: "目录同步", icon: "sync" }, { href: "/admin/price-sync", label: "价格同步", icon: "sync" }] },
  { title: "交易", links: [{ href: "/admin/orders/risk", label: "异常订单", icon: "risk" }] },
  { title: "运营", links: [{ href: "/admin/content", label: "内容", icon: "content" }, { href: "/admin/events", label: "活动", icon: "events" }] },
  { title: "账户", links: [{ href: "/admin/users", label: "玩家", icon: "users" }] },
  { title: "系统", links: [{ href: "/admin/jobs", label: "任务", icon: "jobs" }, { href: "/admin/backups", label: "备份", icon: "backups" }, { href: "/admin/logs", label: "日志", icon: "logs" }] }
];

/** 玩家 HUD：只展示服务端返回的余额、工作资金与自然日，不结算任何经济数据。 */
function PlayerHud() {
  const archive = useArchiveQuery();
  const funding = useDailyWorkFundingStatusQuery(true);
  const balance = archive.data?.data.archive.balance;
  const fundingStatus = funding.data?.data.status;
  const workLabel = fundingStatus?.status === "available" && fundingStatus.amount !== null
    ? `工作资金 可领取 ${formatMoney(fundingStatus.amount)}`
    : fundingStatus?.status === "claimed"
      ? "工作资金 今日已领取"
      : null;
  return <div className="hud">
    {balance ? <span className="hud-item" aria-label="可用余额"><CoinIcon /><strong className="hud-amount">{formatMoney(balance.available)}</strong></span> : null}
    {workLabel ? <span className="hud-item" aria-label="工作资金"><CoinIcon size={13} /><strong className="hud-amount">{workLabel}</strong></span> : null}
    {fundingStatus?.naturalDate ? <span className="hud-item hud-date" aria-label="服务端市场日期">{fundingStatus.naturalDate}</span> : null}
  </div>;
}

function Shell({ children, admin }: Readonly<{ children: React.ReactNode; admin: boolean }>) {
  const { user } = useSession();
  const groups = admin ? adminGroups : playerGroups;
  // 选中态 pathname 只在客户端 effect 中写入：避免基于 pathname 的条件 aria-current 造成
  // 服务端/客户端 hydration 不一致（会导致 React 丢弃并重挂整棵导航树，延迟会话恢复）。
  const [pathname, setPathname] = useState<string | null>(null);
  useEffect(() => {
    const update = () => setPathname(window.location.pathname);
    update();
    window.addEventListener("popstate", update);
    // Next App Router 客户端路由切换走 history.pushState/replaceState。
    const originalPush = window.history.pushState;
    const originalReplace = window.history.replaceState;
    window.history.pushState = function (...args) { const result = originalPush.apply(this, args as Parameters<typeof originalPush>); update(); return result; };
    window.history.replaceState = function (...args) { const result = originalReplace.apply(this, args as Parameters<typeof originalReplace>); update(); return result; };
    return () => {
      window.removeEventListener("popstate", update);
      window.history.pushState = originalPush;
      window.history.replaceState = originalReplace;
    };
  }, []);
  const active = (href: string) => {
    const current = pathname ?? "";
    return href === "/" ? current === href : current === href || current.startsWith(`${href}/`);
  };
  return <div className="app-shell">
    <header className="topbar">
      <Link href={admin ? "/admin" : "/dashboard"} className="brand"><GemIcon size={18} />MTG 市场模拟器</Link>
      {!admin ? <PlayerHud /> : null}
      <span className="user-label">{user?.displayName} · {admin ? "管理员" : "玩家"}</span>
      <SignOutButton />
    </header>
    <div className="shell-body">
      <nav className="side-nav" aria-label={admin ? "管理导航" : "玩家导航"}>
        {groups.map((group) => (
          <div className="side-nav-group" key={group.title}>
            <span className="side-nav-title" aria-hidden="true">{group.title}</span>
            {group.links.map(({ href, label, icon }) => <Link href={href} key={href} aria-current={active(href) ? "page" : undefined}><NavIcon kind={icon ?? "dashboard"} />{label}</Link>)}
          </div>
        ))}
      </nav>
      <main className="content">{children}</main>
    </div>
    {!admin ? <OnboardingGuideTour /> : null}
  </div>;
}

export function PlayerShell({ children }: Readonly<{ children: React.ReactNode }>) { return <Shell admin={false}>{children}</Shell>; }
export function AdminShell({ children }: Readonly<{ children: React.ReactNode }>) { return <Shell admin>{children}</Shell>; }
