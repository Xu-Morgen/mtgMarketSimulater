"use client";

import { Descriptions, Tag } from "antd";
import type { PackDto } from "@mtg-market/contracts";
import Link from "next/link";
import { usePackDetailQuery, usePacksQuery } from "../../api/packs-api";
import { EmptyState, ErrorState, PageSkeleton } from "../../components/ui";
import { formatMoney } from "../../utils/money";
import { PackProbabilityTable } from "./pack-probability-table";
import styles from "./packs-page.module.css";

function PackStatus({ pack }: { pack: PackDto }) {
  if (!pack.enabled)
    return (
      <p className={styles.disabled}>
        <strong>当前不可购买：</strong>
        {pack.disabledReason ?? "该补充包暂未启用。"}
      </p>
    );
  return <p className={styles.enabled}>已启用；购买与开包将在后续版本开放。</p>;
}

function PackCard({ pack }: { pack: PackDto }) {
  return (
    <article className={styles.card}>
      <div>
        <h2>{pack.name}</h2>
        {pack.description ? (
          <p>{pack.description}</p>
        ) : (
          <p className={styles.metadata}>未提供补充包说明。</p>
        )}
      </div>
      <p>
        <strong>价格：</strong>
        {formatMoney(pack.price)}
      </p>
      <p className={styles.metadata}>规则版本：{pack.ruleVersion}</p>
      <PackStatus pack={pack} />
      <Link className="button secondary" href={`/packs/${pack.id}`}>
        查看概率详情
      </Link>
    </article>
  );
}

/** 商店只公示 PackDto；不提供浏览器购买、开奖、保底进度或候选池。 */
export function PacksPage() {
  const packs = usePacksQuery();
  if (packs.isPending) return <PageSkeleton label="正在加载补充包" />;
  if (packs.isError)
    return (
      <main className="page">
        <ErrorState title="补充包加载失败" onRetry={() => void packs.refetch()} />
      </main>
    );
  const items = packs.data.data.items;
  return (
    <main className="page">
      <p className="eyebrow">服务端版本化配置</p>
      <h1>补充包商店</h1>
      <p className="intro">
        价格、启用状态和稀有度概率均来自服务端已发布配置。当前版本只公示信息，不会在浏览器抽卡、保存保底进度或生成开奖结果。
      </p>
      {items.length === 0 ? (
        <EmptyState title="暂无可公示的补充包">
          管理员尚未发布补充包配置。请稍后刷新查看。
        </EmptyState>
      ) : (
        <section className={styles.cards} aria-label="补充包列表">
          {items.map((pack) => (
            <PackCard key={pack.id} pack={pack} />
          ))}
        </section>
      )}
    </main>
  );
}

export function PackDetailPage({ packId }: { packId: string }) {
  const packQuery = usePackDetailQuery(packId);
  if (packQuery.isPending) return <PageSkeleton label="正在加载补充包详情" />;
  if (packQuery.isError)
    return (
      <main className="page">
        <ErrorState title="补充包详情加载失败" onRetry={() => void packQuery.refetch()} />
      </main>
    );
  const pack = packQuery.data.data.pack;
  return (
    <main className={`page ${styles.detail}`}>
      <Link className="back-link" href="/packs">
        返回补充包列表
      </Link>
      <div className={styles.detailHeader}>
        <div>
          <p className="eyebrow">服务端版本化概率</p>
          <h1>{pack.name}</h1>
        </div>
        <Tag color={pack.enabled ? "green" : "default"}>{pack.enabled ? "已启用" : "已禁用"}</Tag>
      </div>
      {pack.description ? <p className="intro">{pack.description}</p> : null}
      <Descriptions
        bordered
        column={1}
        size="small"
        items={[
          { key: "price", label: "价格", children: formatMoney(pack.price) },
          { key: "ruleVersion", label: "规则版本", children: pack.ruleVersion },
          { key: "updatedAt", label: "配置更新时间（UTC）", children: pack.updatedAt }
        ]}
      />
      <div className={styles.slotList}>
        <PackStatus pack={pack} />
        <PackProbabilityTable slots={pack.slots} />
      </div>
      <section className="status-card">
        <h2>概率与保底说明</h2>
        <p>
          这里展示的是服务端发布的规则版本与卡位概率。MVP
          未启用保底机制，因此没有保底进度、计数器或跨包状态可显示或保存。
        </p>
      </section>
    </main>
  );
}
