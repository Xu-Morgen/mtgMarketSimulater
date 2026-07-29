"use client";

import { Alert, Button, Tag } from "antd";
import type { DeckCardEntryDto, DeckDto, DeckLegalityDto, InventoryHoldingDto, VirtualBasicLandDto } from "@mtg-market/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ApiClientError } from "../../api/client";
import { toDeckSaveInput, useDeckQuery, useDeckSaveMutation, useDecksQuery, useDeckValidationMutation } from "../../api/decks-api";
import { useAvailableInventoryQuery } from "../../api/inventory-api";
import { EmptyState, ErrorState, PageSkeleton } from "../../components/ui";
import { useDeckDraftStore } from "../../stores/deck-draft-store";
import styles from "./decks-page.module.css";

const basics: Array<{ value: VirtualBasicLandDto; label: string }> = [{ value: "plains", label: "平原" }, { value: "island", label: "岛" }, { value: "swamp", label: "沼泽" }, { value: "mountain", label: "山脉" }, { value: "forest", label: "树林" }];
const zones = { commander: "指挥官", main: "主牌", companion: "Companion", virtual_basic: "虚拟基本地" } as const;

function errorMessage(error: unknown): string { return error instanceof ApiClientError ? error.message : "请求失败，请检查网络后重试。"; }
function cardKey(card: DeckCardEntryDto): string { return `${card.zone}:${card.skuId ?? card.virtualBasic}`; }

function Legality({ legality, stale }: { legality: DeckLegalityDto | null; stale?: boolean }) {
  if (!legality) return <p className={styles.muted}>草稿变更后请请求服务端检查；浏览器不会自行裁定 Commander 合法性。</p>;
  return <div aria-live="polite"><p className={legality.valid ? styles.serverOk : styles.serverBad}>{stale ? "上次服务端检查（草稿已变更）" : "服务端合法性结果"}：{legality.valid ? "可用于后续报名检查" : "存在问题"}</p><p className={styles.muted}>总张数 {legality.totalCards} · 颜色标识 {legality.colorIdentity.join("/") || "无"} · 规则 {legality.ruleVersion} · 禁牌表 {legality.banlistVersion}</p>{legality.issues.length ? <ul className={styles.issues}>{legality.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul> : null}</div>;
}

function DeckSummary({ deck }: { deck: DeckDto }) {
  return <article className={styles.deckCard}><div className={styles.deckCardHeader}><div><h2>{deck.name}</h2><p className={styles.muted}>{deck.format} · 更新于 {new Date(deck.updatedAt).toLocaleString("zh-CN")}</p></div><Tag color={deck.legality.valid ? "green" : "volcano"}>{deck.legality.valid ? "服务端检查通过" : "服务端提示问题"}</Tag></div><p>规则：{deck.ruleVersion}；禁牌表：{deck.banlistVersion}；当前 {deck.legality.totalCards} 张。</p>{deck.legality.issues.length ? <ul className={styles.issues}>{deck.legality.issues.slice(0, 2).map((issue) => <li key={issue}>{issue}</li>)}</ul> : null}<Link className="button" href={`/decks/${deck.id}`}>编辑草稿</Link></article>;
}

/** 已保存卡组只来自 TanStack Query；未提交的编辑内容留在 Zustand。 */
export function DecksPage() {
  const decks = useDecksQuery();
  if (decks.isPending) return <PageSkeleton label="正在加载 Commander 卡组" />;
  if (decks.isError) return <main className="page"><ErrorState title="卡组加载失败" onRetry={() => void decks.refetch()} /></main>;
  return <main className="page"><p className="eyebrow">Commander · 服务端草稿</p><div className={styles.deckCardHeader}><div><h1>我的卡组</h1><p className="intro">保存不会锁定库存或生成强度评分；报名时才由服务器重新检查资产并生成评分快照。</p></div><Link className="button" href="/decks/new">新建卡组</Link></div>{decks.data.data.items.length === 0 ? <EmptyState title="还没有卡组">从可用库存开始构筑；五种虚拟基本地无限且不占库存。</EmptyState> : <div className={styles.grid}>{decks.data.data.items.map((deck) => <DeckSummary key={deck.id} deck={deck} />)}</div>}</main>;
}

function InventoryPicker({ holdings }: { holdings: InventoryHoldingDto[] }) {
  const setCardZone = useDeckDraftStore((state) => state.setCardZone);
  const [query, setQuery] = useState("");
  const shown = useMemo(() => holdings.filter((holding) => holding.sku.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [holdings, query]);
  return <section className={styles.panel}><h2>可用库存</h2><p className={styles.muted}>数量和锁定量均为服务端库存快照。选择区域只编辑本地草稿，最终可用性由服务端验证。</p><label className={styles.nameField}>筛选卡名<input aria-label="筛选可用库存" value={query} onChange={(event) => setQuery(event.target.value)} /></label><div className={styles.inventoryList}>{shown.length === 0 ? <p className={styles.muted}>没有匹配的可用库存。</p> : shown.map((holding) => <div className={styles.inventoryRow} key={holding.skuId}><div><strong>{holding.sku.name}</strong><p className={styles.muted}>可用 {holding.availableQuantity} / 持有 {holding.quantity}；订单锁定 {holding.orderLockedQuantity}；比赛锁定 {holding.tournamentLockedQuantity}</p></div><div className={styles.actions}><button className="button secondary" type="button" onClick={() => setCardZone({ skuId: holding.skuId, name: holding.sku.name, cardIdentity: holding.skuId }, "commander")}>设为指挥官</button><button className="button secondary" type="button" onClick={() => setCardZone({ skuId: holding.skuId, name: holding.sku.name, cardIdentity: holding.skuId }, "main")}>加入主牌</button><button className="button secondary" type="button" onClick={() => setCardZone({ skuId: holding.skuId, name: holding.sku.name, cardIdentity: holding.skuId }, "companion")}>设为 Companion</button></div></div>)}</div></section>;
}

/** 编辑器不含任何 Commander 规则实现：所有状态只通过 `/validate` 或保存响应显示。 */
export function DeckEditorPage({ deckId }: { deckId?: string }) {
  const router = useRouter(); const stored = useDeckDraftStore();
  const deck = useDeckQuery(deckId); const inventory = useAvailableInventoryQuery();
  const validation = useDeckValidationMutation(); const save = useDeckSaveMutation(deckId);
  const [legality, setLegality] = useState<DeckLegalityDto | null>(null); const [checkedRevision, setCheckedRevision] = useState<number | null>(null); const [saveMessage, setSaveMessage] = useState<string | null>(null);
  useEffect(() => { if (!deckId && stored.sourceDeckId !== "new") stored.initializeNew(); }, [deckId, stored]);
  useEffect(() => { if (deckId && deck.data?.data && stored.sourceDeckId !== deckId) { stored.initializeFromDeck(deck.data.data); setLegality(deck.data.data.legality); setCheckedRevision(stored.revision + 1); } }, [deckId, deck.data?.data, stored]);
  useEffect(() => {
    if (!stored.dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [stored.dirty]);
  if (deckId && deck.isPending) return <PageSkeleton label="正在加载卡组草稿" />;
  if (deckId && deck.isError) return <main className="page"><ErrorState title="卡组加载失败" onRetry={() => void deck.refetch()} /></main>;
  if (inventory.isPending) return <PageSkeleton label="正在读取可用库存" />;
  if (inventory.isError) return <main className="page"><ErrorState title="可用库存加载失败" onRetry={() => void inventory.refetch()} /></main>;
  const input = toDeckSaveInput({ name: stored.name, banlistVersion: stored.banlistVersion, cards: stored.cards });
  const check = () => validation.mutate(input, { onSuccess: ({ data }) => { setLegality(data); setCheckedRevision(stored.revision); }, onError: () => { setLegality(null); setCheckedRevision(null); } });
  const persist = () => save.mutate(input, { onSuccess: ({ data }) => { stored.markSaved(data); setLegality(data.legality); setCheckedRevision(stored.revision + 1); setSaveMessage("草稿已由服务器保存；保存不锁定库存，也不会生成报名评分。"); if (!deckId) router.replace(`/decks/${data.id}`); }, onError: () => setSaveMessage(null) });
  const stale = checkedRevision !== null && checkedRevision !== stored.revision;
  const basicQuantity = (basic: VirtualBasicLandDto) => stored.cards.find((card) => card.zone === "virtual_basic" && card.virtualBasic === basic)?.quantity ?? 0;
  const selected = stored.cards.filter((card) => card.zone !== "virtual_basic");
  return <main className="page"><p className="eyebrow">Commander · 未提交草稿</p><div className={styles.deckCardHeader}><div><h1>{deckId ? "编辑卡组" : "新建卡组"}</h1><p className="intro">带 * 的浏览器状态尚未保存。离开或刷新含未保存变更时，浏览器会提示确认。</p></div><Link className="button secondary" href="/decks" onClick={(event) => { if (stored.dirty && !window.confirm("当前卡组草稿尚未保存，确定离开吗？")) event.preventDefault(); }}>返回卡组列表</Link></div><div className={styles.editor}><section className={styles.grid}><section className={styles.panel}><label className={styles.nameField}>卡组名称<input aria-label="卡组名称" value={stored.name} onChange={(event) => stored.setName(event.target.value)} maxLength={100} /></label><p className={styles.muted}>格式固定为 commander-100/v1；禁牌表版本将随保存结果由服务器返回。</p></section><InventoryPicker holdings={inventory.data} /><section className={styles.panel}><h2>已选卡牌 {stored.dirty ? <span aria-label="存在未保存草稿">*</span> : null}</h2>{selected.length === 0 ? <p className={styles.muted}>尚未选择实体卡牌。可先从库存设定指挥官、主牌或 Companion。</p> : <div className={styles.selectedList}>{selected.map((card) => <div key={cardKey(card)} className={styles.selectedRow}><div><strong>{card.name}</strong><span className={styles.zone}>{zones[card.zone]}</span></div><div className={styles.actions}><label>数量<input className={styles.quantity} aria-label={`${card.name} 数量`} type="number" value={card.quantity} onChange={(event) => stored.setQuantity(cardKey(card), Number(event.target.value))} /></label><button className="button secondary" type="button" onClick={() => stored.removeCard(cardKey(card))}>移除</button></div></div>)}</div>}</section><section className={styles.panel}><h2>无限虚拟基本地</h2><p className={styles.muted}>虚拟基本地不引用 SKU，不创建持仓、市场资产或任何锁定。</p><div className={styles.basicGrid}>{basics.map((basic) => <label key={basic.value}>{basic.label}<input aria-label={`${basic.label} 数量`} type="number" min="0" value={basicQuantity(basic.value)} onChange={(event) => stored.setVirtualBasicQuantity(basic.value, Number(event.target.value))} /></label>)}</div></section></section><aside className={`${styles.grid} ${styles.sticky}`}><section className={styles.panel}><h2>服务端合法性</h2><Legality legality={legality} stale={stale} />{validation.isError ? <Alert type="error" showIcon message={errorMessage(validation.error)} /> : null}<div className={styles.actions}><Button onClick={check} loading={validation.isPending}>请求服务端检查</Button><Button type="primary" onClick={persist} loading={save.isPending}>保存草稿</Button></div>{save.isError ? <Alert type="error" showIcon message={errorMessage(save.error)} /> : null}{saveMessage ? <p className={`${styles.notice} ${styles.success}`} role="status">{saveMessage}</p> : null}</section><section className={styles.panel}><h2>报名评分与锁定</h2>{deck.data?.data.strengthSnapshot ? <p className={styles.muted}>报名评分来源：{deck.data.data.strengthSnapshot.source} · {deck.data.data.strengthSnapshot.sourceVersion} · {deck.data.data.strengthSnapshot.availability}</p> : <p className={styles.muted}>当前草稿尚无报名评分；评分只在未来报名流程由服务器生成。若 Provider 不可用，报名不会收费或锁定卡牌。</p>}<p className={styles.muted}>保存草稿不会锁卡。库存中的订单/比赛锁定量已在左侧逐项显示；保存和未来报名均由服务器复核冲突。</p></section></aside></div></main>;
}
