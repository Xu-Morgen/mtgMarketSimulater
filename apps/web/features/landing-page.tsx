import Link from "next/link";
import { HealthStatus } from "../components/health-status";

/** 品牌纹章：原创 stroke 内联 SVG（盾 + 宝石），非任何版权素材。 */
function Emblem() {
  return (
    <svg className="landing-emblem" viewBox="0 0 96 96" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" aria-hidden="true">
      <path d="M48 4l36 21v27c0 20-14 33-36 40-22-7-36-20-36-40V25L48 4Z" />
      <path d="M48 22l12 8-12 26-12-26 12-8Z" />
      <path d="M36 30h24M48 22l-12 26M48 22l12 26" opacity="0.7" />
      <path d="M34 68h28" opacity="0.8" />
    </svg>
  );
}

/** 陈列柜卡位装饰条：纯 CSS 卡框按稀有度发光（aria-hidden，不影响读屏）。 */
function DisplayCase() {
  const slots: Array<{ rarity: string; label: string }> = [
    { rarity: "common", label: "C" },
    { rarity: "uncommon", label: "U" },
    { rarity: "rare", label: "R" },
    { rarity: "mythic", label: "M" },
    { rarity: "special", label: "S" }
  ];
  return (
    <div className="landing-case" aria-hidden="true">
      {slots.map((slot) => (
        <div className={`case-slot case-${slot.rarity}`} key={slot.rarity}>
          <span className="case-bar" />
          <span className="case-gem" />
          <span className="case-code">{slot.label}</span>
          <span className="case-bar" />
        </div>
      ))}
    </div>
  );
}

function FeatureIcon({ kind }: { kind: "deeds" | "balance" | "health" }) {
  const common = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (kind === "deeds") return <svg {...common}><path d="M12 3c4 2 6 6 6 10H6c0-4 2-8 6-10Z" /><path d="M12 13v8M7 17h10" /></svg>;
  if (kind === "balance") return <svg {...common}><path d="M12 3v18M7 21h10M12 6l-5 7M12 6l5 7" /><path d="M7 13h10" /></svg>;
  return <svg {...common}><path d="M12 21s-7-4.5-9-9a5 5 0 0 1 9-3 5 5 0 0 1 9 3c-2 4.5-9 9-9 9Z" /></svg>;
}

export function LandingPage() {
  return <main className="page landing">
    <section className="landing-hero">
      <Emblem />
      <p className="eyebrow">MTG MARKET SIMULATOR</p>
      <h1>卡牌市场模拟器</h1>
      <p className="intro">使用虚拟货币体验卡牌市场。所有余额、库存和交易结果都由服务器保存与结算。</p>
      <div className="actions">
        <Link className="button" href="/login">登录</Link>
        <Link className="button secondary" href="/register">注册</Link>
      </div>
      <DisplayCase />
    </section>
    <section className="grid">
      <article>
        <span className="feature-icon"><FeatureIcon kind="deeds" /></span>
        <h2>今日行动</h2>
        <p>领取工作资金、开包、构筑卡组、报名比赛。</p>
      </article>
      <article>
        <span className="feature-icon"><FeatureIcon kind="balance" /></span>
        <h2>市场边界</h2>
        <p>展示参考价与游戏内报价，交易结果以服务端结算为准。</p>
      </article>
      <article>
        <span className="feature-icon"><FeatureIcon kind="health" /></span>
        <h2>服务状态</h2>
        <HealthStatus />
      </article>
    </section>
  </main>;
}
