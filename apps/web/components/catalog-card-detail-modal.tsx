"use client";

import { Descriptions, Modal, Spin } from "antd";
import type { CatalogSkuDto } from "@mtg-market/contracts";
import Link from "next/link";
import { useCatalogDetailQuery } from "../api/catalog-api";
import { ErrorState } from "./ui";
import { LocalCatalogImage } from "./local-catalog-image";
import styles from "./catalog-card-detail-modal.module.css";

function sourceLabel(sku: CatalogSkuDto): string { return sku.isManualException ? "运营测试例外" : sku.source === "scryfall" ? "本地 Scryfall 目录" : "人工目录"; }

/** 目录和开包结果复用同一只读详情，罕贵度与图片始终来自本地目录。 */
export function CatalogCardDetailModal({ skuId, onClose }: { skuId: string | null; onClose: () => void }) {
  const detail = useCatalogDetailQuery(skuId);
  return <Modal open={Boolean(skuId)} title="卡牌详情" onCancel={onClose} footer={null} width={760} destroyOnClose>
    {detail.isPending ? <Spin tip="正在加载卡牌详情" /> : detail.isError ? <ErrorState title="卡牌详情加载失败" onRetry={() => void detail.refetch()} /> : detail.data ? (() => {
      const sku = detail.data.data.sku;
      return <><LocalCatalogImage path={sku.image.path} name={sku.name} rarity={sku.rarity} /><Descriptions className={styles.details} bordered column={1} size="small" items={[
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
