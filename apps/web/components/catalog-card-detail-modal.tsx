"use client";

import { Descriptions, Modal, Spin } from "antd";
import type { CatalogSkuDto } from "@mtg-market/contracts";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useCatalogDetailQuery } from "../api/catalog-api";
import { loadPublicWebConfig, publicWebEnvironment } from "../config/public";
import { useSession } from "../providers/session-provider";
import { ErrorState } from "./ui";
import styles from "./catalog-card-detail-modal.module.css";

function sourceLabel(sku: CatalogSkuDto): string { return sku.isManualException ? "运营测试例外" : sku.source === "scryfall" ? "本地 Scryfall 目录" : "人工目录"; }

/** 卡图只经带会话的本地 API 读取，绝不把外部图片 URL 交给浏览器。 */
function LocalCatalogImage({ path, name }: { path: string | null; name: string }) {
  const { accessToken } = useSession();
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!path || !accessToken) { setImageUrl(null); setFailed(false); return; }
    let disposed = false;
    let objectUrl: string | null = null;
    void fetch(`${loadPublicWebConfig(publicWebEnvironment).apiBaseUrl}${path}`, { credentials: "include", headers: { Authorization: `Bearer ${accessToken}` } })
      .then(async (response) => { if (!response.ok) throw new Error("图片读取失败"); return response.blob(); })
      .then((blob) => { objectUrl = URL.createObjectURL(blob); if (!disposed) setImageUrl(objectUrl); })
      .catch(() => { if (!disposed) setFailed(true); });
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [accessToken, path]);
  if (!path) return <div className={styles.imagePlaceholder}>暂无本地图片；管理员可按需缓存该印刷的卡图。</div>;
  if (failed) return <div className={styles.imagePlaceholder}>本地图片暂不可用。</div>;
  return imageUrl ? <img className={styles.image} src={imageUrl} alt={`${name} 卡图`} /> : <Spin tip="正在读取本地图片" />;
}

/** 目录和开包结果复用同一只读详情，罕贵度与图片始终来自本地目录。 */
export function CatalogCardDetailModal({ skuId, onClose }: { skuId: string | null; onClose: () => void }) {
  const detail = useCatalogDetailQuery(skuId);
  return <Modal open={Boolean(skuId)} title="卡牌详情" onCancel={onClose} footer={null} width={760} destroyOnClose>
    {detail.isPending ? <Spin tip="正在加载卡牌详情" /> : detail.isError ? <ErrorState title="卡牌详情加载失败" onRetry={() => void detail.refetch()} /> : detail.data ? (() => {
      const sku = detail.data.data.sku;
      return <><LocalCatalogImage path={sku.image.path} name={sku.name} /><Descriptions className={styles.details} bordered column={1} size="small" items={[
        { key: "name", label: "名称", children: sku.name },
        { key: "sku", label: "SKU ID", children: sku.id },
        { key: "printing", label: "印刷", children: `${sku.setName}（${sku.setCode} #${sku.collectorNumber}）` },
        { key: "finish", label: "工艺", children: sku.finish },
        { key: "rarity", label: "罕贵度", children: sku.rarity },
        { key: "source", label: "来源", children: sourceLabel(sku) },
        { key: "released", label: "发布日期", children: sku.releasedAt ?? "未提供" },
        { key: "artist", label: "画师", children: sku.artist ?? "未提供" },
        { key: "rules", label: "规则文本", children: sku.oracleText ?? "未提供" },
        { key: "legalities", label: "赛制合法性", children: Object.entries(sku.legalities).map(([format, legality]) => `${format}：${legality}`).join("；") || "未提供" }
      ]} /><div className="actions"><Link className="button secondary" href={`/inventory?query=${encodeURIComponent(sku.name)}`}>在库存中查看</Link><Link className="button secondary" href="/tournaments">前往比赛</Link></div></>;
    })() : null}
  </Modal>;
}
