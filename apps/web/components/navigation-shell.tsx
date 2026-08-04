"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useLogoutMutation } from "../api/auth-mutations";
import { useArchiveQuery } from "../api/archive-api";
import { useDailyWorkFundingStatusQuery } from "../api/daily-work-funding-api";
import { useSession } from "../providers/session-provider";
import { formatMoney } from "../utils/money";

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

function SignOutButton() {
  const router = useRouter();
  const logout = useLogoutMutation();
  return <button className="text-button" disabled={logout.isPending} onClick={() => logout.mutate(undefined, { onSuccess: () => router.replace("/login") })}>{logout.isPending ? "正在退出…" : "退出登录"}</button>;
}

type NavLink = { href: string; label: string };
type NavGroup = { title: string; links: NavLink[] };

const playerGroups: NavGroup[] = [
  { title: "大厅", links: [{ href: "/dashboard", label: "玩家首页" }, { href: "/collection", label: "收藏册" }] },
  { title: "市场", links: [{ href: "/catalog", label: "卡牌目录" }, { href: "/market", label: "市场" }, { href: "/market/history", label: "价格历史" }, { href: "/orders", label: "我的委托" }] },
  { title: "卡牌经营", links: [{ href: "/packs", label: "补充包商店" }, { href: "/inventory", label: "我的库存" }, { href: "/decks", label: "我的卡组" }] },
  { title: "赛事与成长", links: [{ href: "/tournaments", label: "比赛" }, { href: "/achievements", label: "成就" }] },
  { title: "数据", links: [{ href: "/exports", label: "我的数据导出" }] }
];

const adminGroups: NavGroup[] = [
  { title: "总览", links: [{ href: "/admin", label: "后台首页" }] },
  { title: "同步", links: [{ href: "/admin/catalog-sync", label: "目录同步" }, { href: "/admin/price-sync", label: "价格同步" }] },
  { title: "交易", links: [{ href: "/admin/orders/risk", label: "异常订单" }] },
  { title: "运营", links: [{ href: "/admin/content", label: "内容" }, { href: "/admin/events", label: "活动" }] },
  { title: "账户", links: [{ href: "/admin/users", label: "玩家" }] },
  { title: "系统", links: [{ href: "/admin/jobs", label: "任务" }, { href: "/admin/backups", label: "备份" }, { href: "/admin/logs", label: "日志" }] }
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
            {group.links.map(({ href, label }) => <Link href={href} key={href} aria-current={active(href) ? "page" : undefined}>{label}</Link>)}
          </div>
        ))}
      </nav>
      <main className="content">{children}</main>
    </div>
  </div>;
}

export function PlayerShell({ children }: Readonly<{ children: React.ReactNode }>) { return <Shell admin={false}>{children}</Shell>; }
export function AdminShell({ children }: Readonly<{ children: React.ReactNode }>) { return <Shell admin>{children}</Shell>; }
