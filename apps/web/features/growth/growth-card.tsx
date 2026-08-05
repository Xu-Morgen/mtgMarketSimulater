"use client";

import type { GrowthProfileDto } from "@mtg-market/contracts";
import { formatMoney } from "../../utils/money";
import styles from "./growth-card.module.css";

/** 等级图标：原创 stroke 内联 SVG（菱形徽记，aria-hidden 装饰）。 */
function LevelIcon({ className }: { className?: string }) {
  return <svg className={className} width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3l2 4 4 2-4 2-2 4-2-4-4-2 4-2 2-4Z" />
    <path d="M7 19h10" />
  </svg>;
}

/**
 * I35F（I35B F5）等级/声望卡片：等级、称号、经验条与已解锁能力全部取服务端档案，
 * 浏览器只做展示格式化（progressBasisPoints → 百分比宽度），不推算经验或解锁。
 * 玩家首页与任务中心复用同一组件，保证两处展示一致。
 */
export function GrowthCard({ profile }: { profile: GrowthProfileDto }) {
  const isMaxLevel = profile.nextLevelXp === null;
  const progressPercent = Math.min(100, profile.progressBasisPoints / 100);
  return (
    <section className={styles.card} aria-label={`等级 ${profile.level} ${profile.title}`}>
      <div className={styles.head}>
        <span className={styles.icon} aria-hidden="true"><LevelIcon /></span>
        <div>
          <p className="eyebrow">等级 / 声望 · {profile.ruleVersion}</p>
          <h2>{profile.title}</h2>
        </div>
        <span className={styles.levelBadge}>Lv.{profile.level}</span>
      </div>
      <div className={styles.xpRow}>
        <span className={styles.xpLabel}>经验</span>
        <div className={styles.xpTrack} role="img" aria-label={`经验进度 ${profile.progressBasisPoints / 100}%`}>
          <div className={styles.xpFill} style={{ width: `${progressPercent}%` }} />
        </div>
        <span className={styles.xpValue}>
          {profile.totalXp.toLocaleString("zh-CN")}
          {isMaxLevel ? " · 已达最高等级" : ` / ${profile.nextLevelXp!.toLocaleString("zh-CN")}`}
        </span>
      </div>
      <div className={styles.capabilities}>
        <span className={styles.cap}>NPC 每日交易额度 ×{profile.capabilities.npcDailyTradeMultiplier}</span>
        <span className={styles.cap}>单次批量开包上限 {profile.capabilities.bulkPackMax} 包</span>
      </div>
      <p className={styles.meta}>历史峰值净资产 {formatMoney(profile.peakNetWorth)} · 服务端更新 {new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(profile.updatedAt))}</p>
    </section>
  );
}
