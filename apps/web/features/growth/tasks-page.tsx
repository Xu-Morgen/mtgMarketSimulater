"use client";

import type { GrowthProfileDto, TaskCenterDto, TaskInstanceDto } from "@mtg-market/contracts";
import { useRef, useState } from "react";
import { ApiClientError } from "../../api/client";
import { useClaimTaskMutation, useGrowthQuery, useTasksQuery } from "../../api/growth-api";
import { ConfirmDialog, EmptyState, ErrorState, PageSkeleton } from "../../components/ui";
import { formatMoney } from "../../utils/money";
import { GrowthCard } from "./growth-card";
import styles from "./tasks-page.module.css";

/** 服务端周期键/周期类型只读展示；浏览器不以本地日期判断周期或刷新资格。 */
function periodKeyLabel(key: string): string {
  const week = /^(\d{4})-W(\d{2})$/.exec(key);
  if (week) return `${week[1]} 年第 ${Number(week[2])} 周`;
  return key;
}

function metricLabel(metric: TaskInstanceDto["metricType"]): string {
  switch (metric) {
    case "pack.open": return "开包次数";
    case "trade": return "交易张数";
    case "npc.sell": return "向 NPC 卖出笔数";
    case "collection.value": return "持仓价值";
    case "tournament.play": return "赛事结算场次";
    case "set.completion": return "系列收集完成度";
  }
}

function stateChip(status: TaskInstanceDto["status"]): { label: string; className: string } {
  if (status === "claimed") return { label: "已领取", className: styles.claimed ?? "" };
  if (status === "claimable") return { label: "可领取", className: styles.claimable ?? "" };
  return { label: "进行中", className: styles.pending ?? "" };
}

function TaskItem({ instance, claiming, onClaim }: {
  instance: TaskInstanceDto;
  claiming: boolean;
  onClaim: () => void;
}) {
  const chip = stateChip(instance.status);
  const percent = instance.targetAmount > 0 ? Math.min(100, (instance.currentValue / instance.targetAmount) * 100) : 0;
  return (
    <li className={styles.taskItem}>
      <div className={styles.taskMain}>
        <p className={styles.taskTitle}>{instance.title}</p>
        <p className={styles.taskDesc}>
          {instance.description}（{metricLabel(instance.metricType)}）· 周期 {periodKeyLabel(instance.periodKey)}
        </p>
      </div>
      <div className={styles.taskProgress}>
        <div className={styles.progressTrack} role="img" aria-label={`任务进度 ${percent}%`}>
          <div className={styles.progressFill} style={{ width: `${percent}%` }} />
        </div>
        <span className={styles.progressValue}>
          {instance.currentValue.toLocaleString("zh-CN")} / {instance.targetAmount.toLocaleString("zh-CN")}
          {instance.metricType === "set.completion" ? "%" : ""}
        </span>
      </div>
      <span className={`${styles.stateChip} ${chip.className}`}>{chip.label}</span>
      <div className={styles.taskActions}>
        {instance.status === "claimable" ? (
          <button className="button" type="button" disabled={claiming} onClick={onClaim}>
            {claiming ? "正在向服务器领取…" : `领取 ${formatMoney({ amount: instance.rewardAmount, currency: "GAME_CREDIT" })}`}
          </button>
        ) : instance.status === "claimed" ? (
          <button className="button secondary" type="button" disabled>奖励已领取</button>
        ) : (
          <button className="button secondary" type="button" disabled>继续完成目标</button>
        )}
      </div>
    </li>
  );
}

function TaskSection({ title, instances, pendingClaimId, onClaim }: {
  title: string;
  instances: TaskInstanceDto[];
  pendingClaimId: string | null;
  onClaim: (instance: TaskInstanceDto) => void;
}) {
  if (instances.length === 0) return null;
  return (
    <section className="dashboard-section" aria-labelledby={`${title}-heading`}>
      <h2 id={`${title}-heading`}>{title}</h2>
      <ul className={styles.taskList}>
        {instances.map((instance) => (
          <TaskItem key={`${instance.definitionId}-${instance.periodKey}`} instance={instance} claiming={pendingClaimId === instance.id} onClaim={() => onClaim(instance)} />
        ))}
      </ul>
    </section>
  );
}

/** I35F（I35B F3/F5）任务中心：进度与领取状态只取服务端；领取为显式幂等命令，完成判定不在浏览器。 */
export function TasksPage() {
  const tasks = useTasksQuery();
  const growth = useGrowthQuery();
  const claim = useClaimTaskMutation();
  const [pendingClaim, setPendingClaim] = useState<TaskInstanceDto | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claimResult, setClaimResult] = useState<string | null>(null);
  const claimLock = useRef(false);

  if (tasks.isPending) return <PageSkeleton label="正在加载任务中心" />;
  if (tasks.isError) {
    return (
      <main className="page">
        <ErrorState title="任务中心加载失败" onRetry={() => void tasks.refetch()} />
      </main>
    );
  }
  const center = tasks.data?.data as TaskCenterDto | undefined;
  const profile = growth.data?.data as GrowthProfileDto | undefined;
  const daily = center?.daily ?? [];
  const weekly = center?.weekly ?? [];
  const pendingRewardCount = center?.pendingRewardCount ?? 0;

  const confirmClaim = () => {
    if (!pendingClaim || claim.isPending || claimLock.current) return;
    setClaimError(null);
    setClaimResult(null);
    claimLock.current = true;
    claim.mutate({ instanceId: pendingClaim.id }, {
      onSuccess: ({ data }) => {
        claimLock.current = false;
        setPendingClaim(null);
        setClaimResult(`已领取奖励 ${formatMoney(data.reward)}，当前可用余额 ${formatMoney(data.balance)}（由服务器入账）。`);
      },
      onError: (error) => {
        claimLock.current = false;
        setClaimError(error instanceof ApiClientError ? error.message : error instanceof Error ? error.message : "领取任务奖励未完成，请重试。");
        setPendingClaim(null);
      }
    });
  };

  return (
    <main className="page tasks-page">
      <p className="eyebrow">服务端每日目标与长期成长</p>
      <h1>任务中心</h1>
      <p className="intro">今日/本周任务进度与可领取奖励只由服务器基于已结算事实推进；领取奖励为显式命令（幂等键 + 状态机），页面不判定完成、不统计进度、不推算经验。</p>

      {profile ? <section className={styles.growthRow}><GrowthCard profile={profile} /></section> : null}

      <section className={styles.claimBar} aria-label="任务奖励领取状态">
        {pendingRewardCount > 0 ? (
          <p className={styles.claimReady} role="status">有 {pendingRewardCount} 项任务奖励可领取。</p>
        ) : (
          <p className={styles.claimIdle}>当前没有可领取的任务奖励；继续完成服务端记录的目标即可。</p>
        )}
        {claimResult ? <p className={styles.claimSuccess} role="status">{claimResult}</p> : null}
        {claimError ? <p className="form-error" role="alert">{claimError}<button className="text-button" type="button" onClick={() => { setClaimError(null); claim.beginNewIntent(); }}>重试</button></p> : null}
      </section>

      {daily.length === 0 && weekly.length === 0 ? (
        <EmptyState title="今日暂无任务">服务端尚未返回任务定义，请稍后刷新。</EmptyState>
      ) : (
        <>
          <TaskSection title="今日任务" instances={daily} pendingClaimId={claim.isPending ? claim.variables?.instanceId ?? null : null} onClaim={(instance) => { setClaimResult(null); setClaimError(null); setPendingClaim(instance); }} />
          <TaskSection title="本周任务" instances={weekly} pendingClaimId={claim.isPending ? claim.variables?.instanceId ?? null : null} onClaim={(instance) => { setClaimResult(null); setClaimError(null); setPendingClaim(instance); }} />
          <p className={styles.periodMeta}>
            服务端周期：日 {center?.period.day ?? "—"} · 周 {periodKeyLabel(center?.period.week ?? "—")}
          </p>
        </>
      )}

      <ConfirmDialog
        open={pendingClaim !== null}
        title="确认领取任务奖励"
        description={pendingClaim ? `将领取「${pendingClaim.title}」的奖励 ${formatMoney({ amount: pendingClaim.rewardAmount, currency: "GAME_CREDIT" })}，由服务器入账并写入账本流水。重复点击只提交一次。是否确认？` : ""}
        onCancel={() => setPendingClaim(null)}
        onConfirm={confirmClaim}
      />
    </main>
  );
}
